package main

import (
	"encoding/json"
	"testing"
	"time"

	"mowgli-connect-sim/foxglove-sim/cdr"
)

func TestGridCDRRoundTrip(t *testing.T) {
	schema, err := cdr.ParseSchema("std_msgs/Header header\nnav_msgs/MapMetaData info\nint8[] data\n" + common)
	if err != nil {
		t.Fatal(err)
	}
	input := makeData("grid", time.Unix(123, 0), 16, 20)
	b, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := cdr.SerializeCDR(b, schema)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := cdr.DeserializeCDR(encoded, schema)
	if err != nil {
		t.Fatal(err)
	}
	info := decoded["info"].(map[string]interface{})
	if info["width"] != uint32(16) || len(decoded["data"].([]int)) != 256 {
		t.Fatalf("bad grid: %v", info)
	}
}

func TestAreaServiceCDRRoundTrip(t *testing.T) {
	schema, err := cdr.ParseSchema("mowgli_interfaces/MapArea area\nbool success\n" + common)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(M{"area": area(2, 100, false), "success": true})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := cdr.SerializeCDR(b, schema)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := cdr.DeserializeCDR(encoded, schema)
	if err != nil {
		t.Fatal(err)
	}
	a := decoded["area"].(map[string]interface{})
	polygon := a["area"].(map[string]interface{})
	if decoded["success"] != true || a["name"] != "Garden 3" || len(polygon["points"].([]interface{})) != 100 {
		t.Fatalf("bad area: %v", a["name"])
	}
}

func TestStressMapApproximateJSONSize(t *testing.T) {
	areas := make([]M, 10)
	for i := range areas {
		areas[i] = area(i, 3000, false)
	}
	b, err := json.Marshal(M{"working_area": areas})
	if err != nil {
		t.Fatal(err)
	}
	if len(b) < 900_000 || len(b) > 2_500_000 {
		t.Fatalf("unexpected stress map JSON size: %d", len(b))
	}
	t.Logf("stress map JSON: %d bytes", len(b))
}
