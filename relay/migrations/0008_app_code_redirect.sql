-- The redirect URI a code was issued for; the token exchange must name the same one (RFC 6749
-- 4.1.3), now that a private-use scheme can be configured besides the relay's HTTPS callback.
ALTER TABLE app_codes ADD COLUMN redirect_uri TEXT;
