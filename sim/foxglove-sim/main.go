// foxglove-sim is a synthetic Foxglove bridge; it never controls a robot.
package main

import (
	"embed"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"mowgli-connect-sim/foxglove-sim/cdr"
)

type M = map[string]interface{}
type channel struct {
	ID             int    `json:"id"`
	Topic          string `json:"topic"`
	Encoding       string `json:"encoding"`
	SchemaName     string `json:"schemaName"`
	SchemaEncoding string `json:"schemaEncoding"`
	Schema         string `json:"schema"`
	rate           float64
	kind           string
}

//go:embed schemas/*.msg
var schemaFiles embed.FS
var common = `
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: geometry_msgs/Point
float64 x
float64 y
float64 z
================================================================================
MSG: geometry_msgs/Point32
float32 x
float32 y
float32 z
================================================================================
MSG: geometry_msgs/Quaternion
float64 x
float64 y
float64 z
float64 w
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
================================================================================
MSG: geometry_msgs/Pose
geometry_msgs/Point position
geometry_msgs/Quaternion orientation
================================================================================
MSG: geometry_msgs/PoseStamped
std_msgs/Header header
geometry_msgs/Pose pose
================================================================================
MSG: geometry_msgs/PoseWithCovariance
geometry_msgs/Pose pose
float64[36] covariance
================================================================================
MSG: geometry_msgs/Twist
geometry_msgs/Vector3 linear
geometry_msgs/Vector3 angular
================================================================================
MSG: geometry_msgs/TwistWithCovariance
geometry_msgs/Twist twist
float64[36] covariance
================================================================================
MSG: geometry_msgs/Polygon
geometry_msgs/Point32[] points
================================================================================
MSG: nav_msgs/MapMetaData
builtin_interfaces/Time map_load_time
float32 resolution
uint32 width
uint32 height
geometry_msgs/Pose origin
================================================================================
MSG: sensor_msgs/NavSatStatus
int8 status
uint16 service
================================================================================
MSG: mowgli_interfaces/MapObstacleInfo
string name
uint8 source
bool pending
uint32 id
================================================================================
MSG: mowgli_interfaces/TrackedObstacle
uint32 id
geometry_msgs/Polygon polygon
geometry_msgs/Point centroid
float64 radius
builtin_interfaces/Time first_seen
uint32 observation_count
uint8 status
================================================================================
MSG: mowgli_interfaces/MapArea
string name
geometry_msgs/Polygon area
geometry_msgs/Polygon[] obstacles
bool is_navigation_area
mowgli_interfaces/MapObstacleInfo[] obstacle_info
geometry_msgs/Polygon[] proposed_obstacles
mowgli_interfaces/MapObstacleInfo[] proposed_obstacle_info
uint32 id
`
var upgrader = websocket.Upgrader{Subprotocols: []string{"foxglove.websocket.v1"}}

func main() {
	addr := flag.String("listen", "127.0.0.1:8765", "listen address")
	preset := flag.String("preset", "default", "default or stress")
	grid := flag.Int("grid-size", 400, "grid width and height")
	gridRate := flag.Float64("grid-rate", 1, "grid Hz")
	flag.Float64Var(&gridNoise, "grid-noise", 0, "fraction of grid cells set to random values in each frame (pessimistic compressibility)")
	scanRate := flag.Float64("scan-rate", 20, "scan Hz")
	scans := flag.Int("scan-ranges", 720, "scan sample count")
	areas := flag.Int("areas", 4, "number of areas (1-99)")
	points := flag.Int("area-points", 100, "points per area")
	flag.Parse()
	if *preset == "stress" {
		*grid = 1000
		*gridRate = 2
		*areas = 10
		*points = 3000
	} else if *preset != "default" {
		log.Fatal("unknown preset")
	}
	if *grid < 1 || *grid > 2000 || *gridRate <= 0 || *scanRate <= 0 || *scans < 1 || *areas < 1 || *areas > 99 || *points < 3 {
		log.Fatal("invalid size, count or rate")
	}
	var cs []channel
	add := func(topic, typ, root, kind string, rate float64) {
		cs = append(cs, channel{len(cs) + 1, topic, "cdr", typ, "ros2msg", root + common, rate, kind})
	}
	load := func(name string) string {
		b, e := schemaFiles.ReadFile("schemas/" + name + ".msg")
		if e != nil {
			log.Fatal(e)
		}
		return string(b)
	}
	add("/hardware_bridge/status", "mowgli_interfaces/msg/Status", load("Status"), "status", 1)
	add("/behavior_tree_node/high_level_status", "mowgli_interfaces/msg/HighLevelStatus", load("HighLevelStatus"), "high", 1)
	add("/hardware_bridge/power", "mowgli_interfaces/msg/Power", load("Power"), "power", 1)
	add("/hardware_bridge/emergency", "mowgli_interfaces/msg/Emergency", load("Emergency"), "emergency", 1)
	add("/odometry/filtered_map", "nav_msgs/msg/Odometry", "std_msgs/Header header\nstring child_frame_id\ngeometry_msgs/PoseWithCovariance pose\ngeometry_msgs/TwistWithCovariance twist\n", "pose", 10)
	add("/gps/status", "mowgli_interfaces/msg/GnssStatus", load("GnssStatus"), "gnss", 1)
	add("/behavior_tree_node/coverage_session", "mowgli_interfaces/msg/CoverageSession", load("CoverageSession"), "coverage", 1)
	add("/gps/fix", "sensor_msgs/msg/NavSatFix", "std_msgs/Header header\nsensor_msgs/NavSatStatus status\nfloat64 latitude\nfloat64 longitude\nfloat64 altitude\nfloat64[9] position_covariance\nuint8 position_covariance_type\n", "gps", 5)
	add("/imu/data", "sensor_msgs/msg/Imu", "std_msgs/Header header\ngeometry_msgs/Quaternion orientation\nfloat64[9] orientation_covariance\ngeometry_msgs/Vector3 angular_velocity\nfloat64[9] angular_velocity_covariance\ngeometry_msgs/Vector3 linear_acceleration\nfloat64[9] linear_acceleration_covariance\n", "imu", 10)
	add("/scan", "sensor_msgs/msg/LaserScan", "std_msgs/Header header\nfloat32 angle_min\nfloat32 angle_max\nfloat32 angle_increment\nfloat32 time_increment\nfloat32 scan_time\nfloat32 range_min\nfloat32 range_max\nfloat32[] ranges\nfloat32[] intensities\n", "scan", *scanRate)
	for _, t := range []string{"/map_server_node/mow_progress", "/fusion_graph/lidar_map"} {
		add(t, "nav_msgs/msg/OccupancyGrid", "std_msgs/Header header\nnav_msgs/MapMetaData info\nint8[] data\n", "grid", *gridRate)
	}
	add("/coverage/plan_preview", "mowgli_interfaces/msg/CoveragePlanPreview", load("CoveragePlanPreview"), "path", 1)
	add("/plan", "nav_msgs/msg/Path", "std_msgs/Header header\ngeometry_msgs/PoseStamped[] poses\n", "plan", 1)
	add("/obstacle_tracker/obstacles", "mowgli_interfaces/msg/ObstacleArray", "std_msgs/Header header\nmowgli_interfaces/TrackedObstacle[] obstacles\n", "obstacles", 1)
	serviceSchema := "mowgli_interfaces/MapArea area\nbool success\n" + common
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		log.Printf("GUI connected: %s", r.RemoteAddr)
		var mu sync.Mutex
		write := func(typ int, b []byte) error { mu.Lock(); defer mu.Unlock(); return conn.WriteMessage(typ, b) }
		send := func(v interface{}) { b, _ := json.Marshal(v); _ = write(websocket.TextMessage, b) }
		send(M{"op": "serverInfo", "name": "Mowgli synthetic robot", "capabilities": []string{"services"}, "supportedEncodings": []string{"cdr"}, "sessionId": "sim"})
		send(M{"op": "advertise", "channels": cs})
		send(M{"op": "advertiseServices", "services": []interface{}{M{"id": 1, "name": "/map_server_node/get_mowing_area", "type": "mowgli_interfaces/srv/GetMowingArea", "request": M{"encoding": "cdr", "schema": "uint32 index\n"}, "response": M{"encoding": "cdr", "schema": serviceSchema}}}})
		done := make(chan struct{})
		defer close(done)
		var subs sync.Map
		for _, ch := range cs {
			ch := ch
			go func() {
				ticker := time.NewTicker(time.Duration(float64(time.Second) / ch.rate))
				defer ticker.Stop()
				for {
					select {
					case <-done:
						return
					case now := <-ticker.C:
						subs.Range(func(key, value interface{}) bool {
							if value.(int) != ch.ID {
								return true
							}
							msg := makeData(ch.kind, now, *grid, *scans)
							j, _ := json.Marshal(msg)
							schema, e := cdr.ParseSchema(ch.Schema)
							if e != nil {
								log.Print(e)
								return true
							}
							b, e := cdr.SerializeCDR(j, schema)
							if e != nil {
								log.Print(e)
								return true
							}
							frame := make([]byte, 13+len(b))
							frame[0] = 1
							binary.LittleEndian.PutUint32(frame[1:], key.(uint32))
							binary.LittleEndian.PutUint64(frame[5:], uint64(now.UnixNano()))
							copy(frame[13:], b)
							_ = write(websocket.BinaryMessage, frame)
							return true
						})
					}
				}
			}()
		}
		for {
			typ, b, e := conn.ReadMessage()
			if e != nil {
				return
			}
			if typ == websocket.TextMessage {
				var op struct {
					Op            string `json:"op"`
					Subscriptions []struct {
						ID        uint32 `json:"id"`
						ChannelID int    `json:"channelId"`
					} `json:"subscriptions"`
					IDs []uint32 `json:"subscriptionIds"`
				}
				if json.Unmarshal(b, &op) != nil {
					continue
				}
				for _, s := range op.Subscriptions {
					if s.ChannelID > 0 && s.ChannelID <= len(cs) {
						subs.Store(s.ID, s.ChannelID)
						log.Printf("subscribe %s", cs[s.ChannelID-1].Topic)
					}
				}
				for _, id := range op.IDs {
					subs.Delete(id)
				}
			} else if typ == websocket.BinaryMessage && len(b) >= 20 && b[0] == 2 {
				encLen := int(binary.LittleEndian.Uint32(b[9:13]))
				if 13+encLen+8 > len(b) {
					continue
				}
				idx := int(binary.LittleEndian.Uint32(b[13+encLen+4:]))
				v := M{"success": idx < *areas}
				if idx < *areas {
					v["area"] = area(idx, *points, *preset == "stress")
				}
				j, _ := json.Marshal(v)
				s, _ := cdr.ParseSchema(serviceSchema)
				payload, e := cdr.SerializeCDR(j, s)
				if e != nil {
					log.Print(e)
					continue
				}
				out := append([]byte{3}, b[1:13+encLen]...)
				out = append(out, payload...)
				_ = write(websocket.BinaryMessage, out)
			}
		}
	})
	log.Printf("listening on %s (%s)", *addr, *preset)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
func area(i, n int, changing bool) M {
	p := make([]M, n)
	phase := 0.
	if changing {
		phase = float64(time.Now().Unix()/5) * .0001
	}
	for j := range p {
		a := 2 * math.Pi * float64(j) / float64(n)
		p[j] = M{"x": float32(float64(i)*25 + 10*math.Cos(a) + phase), "y": float32(10 * math.Sin(a)), "z": 0}
	}
	return M{"name": fmt.Sprintf("Garden %d", i+1), "id": i + 1, "area": M{"points": p}, "obstacles": []M{}, "proposed_obstacles": []M{}}
}

var gridNoise float64

func makeData(kind string, now time.Time, size, n int) M {
	t := float64(now.UnixNano()) / 1e9
	header := M{"stamp": M{"sec": now.Unix(), "nanosec": now.Nanosecond()}, "frame_id": "map"}
	pose := M{"position": M{"x": 5 + 4*math.Cos(t/30), "y": 5 + 4*math.Sin(t/30)}, "orientation": M{"w": 1}}
	m := M{"header": header}
	switch kind {
	case "status":
		return M{"stamp": header["stamp"], "mower_status": 255, "raspberry_pi_power": true, "mow_enabled": true, "firmware_compatible": true, "firmware_version": "sim", "mower_motor_rpm": 2400}
	case "high":
		return M{"state": 2, "state_name": "Mowing", "coverage_percent": 42, "battery_percent": 78, "gps_quality_percent": 95}
	case "power":
		return M{"stamp": header["stamp"], "v_battery": 25.4, "charger_status": "disconnected"}
	case "emergency":
		return M{"stamp": header["stamp"], "reason": ""}
	case "pose":
		m["pose"] = M{"pose": pose}
		m["child_frame_id"] = "base_link"
	case "gnss":
		m["fix_type"] = 3
		m["fix_valid"] = true
		m["quality_percent"] = 95
		m["satellites_used"] = 18
	case "coverage":
		m["session_active"] = true
		m["current_area"] = 0
	case "gps":
		m["latitude"] = 59.3293
		m["longitude"] = 18.0686
		m["altitude"] = 25
		m["status"] = M{"status": 2, "service": 1}
	case "imu":
		m["orientation"] = M{"w": 1}
		m["linear_acceleration"] = M{"z": 9.81}
	case "scan":
		a := make([]float32, n)
		b := make([]float32, n)
		for i := range a {
			a[i] = float32(3 + math.Sin(float64(i)/30+t/5))
			b[i] = float32(40 + i%60)
		}
		m["ranges"] = a
		m["intensities"] = b
		m["angle_min"] = -math.Pi
		m["angle_max"] = math.Pi
		m["angle_increment"] = 2 * math.Pi / float64(n)
		m["range_min"] = .1
		m["range_max"] = 12
		m["scan_time"] = .05
	case "grid":
		a := make([]int8, size*size)
		for i := range a {
			x, y := i%size, i/size
			if x < 3 || y < 3 || x > size-4 || y > size-4 {
				a[i] = 100
			} else if (x+y+int(t))%71 < 5 {
				a[i] = -1
			} else {
				a[i] = int8((x/30 + y/30) % 2 * 30)
			}
		}
		for i := 0; gridNoise > 0 && i < int(gridNoise*float64(len(a))); i++ {
			a[rand.IntN(len(a))] = int8(rand.IntN(102) - 1)
		}
		m["info"] = M{"width": size, "height": size, "resolution": .05, "origin": M{"orientation": M{"w": 1}}}
		m["data"] = a
	case "path":
		var xy []float32
		for i := 0; i < 100; i++ {
			xy = append(xy, float32(i)/10, float32(i%10))
		}
		m["xy"] = xy
		m["subpath_offsets"] = []int{0, 100}
	case "plan":
		p := make([]M, 30)
		for i := range p {
			p[i] = M{"header": header, "pose": M{"position": M{"x": float64(i) / 5, "y": float64(i % 5)}, "orientation": M{"w": 1}}}
		}
		m["poses"] = p
	case "obstacles":
		m["obstacles"] = []M{}
	}
	return m
}
