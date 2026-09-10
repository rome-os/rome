package hosthelper

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"syscall"
	"unicode/utf8"
)

const maxBodyBytes = 512 * 1024
const maxJobs = 10000

var identifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type Config struct {
	HostID            string `json:"hostId"`
	Enabled           bool   `json:"enabled"`
	SocketPath        string `json:"socketPath"`
	StateDir          string `json:"stateDir"`
	SocketGID         int    `json:"socketGid"`
	MaxTimeoutSeconds int    `json:"maxTimeoutSeconds"`
	MaxOutputBytes    int    `json:"maxOutputBytes"`
}

func (c *Config) defaults() {
	if c.SocketPath == "" {
		c.SocketPath = "/run/rome-host/control.sock"
	}
	if c.StateDir == "" {
		c.StateDir = "/var/lib/rome-host"
	}
	if c.MaxTimeoutSeconds == 0 {
		c.MaxTimeoutSeconds = 600
	}
	if c.MaxOutputBytes == 0 {
		c.MaxOutputBytes = 128 * 1024
	}
}

func (c Config) validate() error {
	if !identifier.MatchString(c.HostID) {
		return errors.New("hostId must be a 1..128 character identifier")
	}
	if c.SocketGID < 0 || uint64(c.SocketGID) > 4294967294 {
		return errors.New("invalid socketGid")
	}
	if c.MaxTimeoutSeconds < 1 || c.MaxTimeoutSeconds > 600 {
		return errors.New("maxTimeoutSeconds must be 1..600")
	}
	if c.MaxOutputBytes < 1 || c.MaxOutputBytes > 128*1024 {
		return errors.New("maxOutputBytes must be 1..131072")
	}
	if !filepath.IsAbs(c.SocketPath) || filepath.Clean(c.SocketPath) != c.SocketPath || len(c.SocketPath) > 100 {
		return errors.New("socketPath must be a clean absolute path of at most 100 bytes")
	}
	if !filepath.IsAbs(c.StateDir) || filepath.Clean(c.StateDir) != c.StateDir || c.StateDir == "/" {
		return errors.New("stateDir must be a clean absolute directory path")
	}
	return nil
}

// LoadConfig requires a regular file owned by this UID with no unprivileged writers.
func LoadConfig(path string) (Config, error) {
	c := Config{}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return c, errors.New("config path must be clean and absolute")
	}
	if err := protectedPath(filepath.Dir(path)); err != nil {
		return c, err
	}
	if err := protectedFile(path); err != nil {
		return c, err
	}
	f, err := os.Open(path)
	if err != nil {
		return c, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxBodyBytes+1))
	if err != nil {
		return c, err
	}
	if len(b) > maxBodyBytes {
		return c, errors.New("config is too large")
	}
	if err = strictJSON(b, &c, []string{"hostId", "socketGid"}); err != nil {
		return c, err
	}
	var fields map[string]json.RawMessage
	json.Unmarshal(b, &fields)
	if _, ok := fields["maxTimeoutSeconds"]; ok && c.MaxTimeoutSeconds == 0 {
		return c, errors.New("maxTimeoutSeconds must be positive")
	}
	if _, ok := fields["maxOutputBytes"]; ok && c.MaxOutputBytes == 0 {
		return c, errors.New("maxOutputBytes must be positive")
	}
	c.defaults()
	return c, c.validate()
}

func strictJSON(data []byte, target any, required []string) error {
	if !utf8.Valid(data) {
		return errors.New("JSON must be UTF-8")
	}
	t := reflect.TypeOf(target).Elem()
	allowed := map[string]bool{}
	for i := 0; i < t.NumField(); i++ {
		allowed[t.Field(i).Tag.Get("json")] = true
	}
	d := json.NewDecoder(bytes.NewReader(data))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("expected a JSON object")
	}
	seen := map[string]bool{}
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok || !allowed[key] || seen[key] {
			return errors.New("unknown or duplicate JSON field")
		}
		seen[key] = true
		var value json.RawMessage
		if err = d.Decode(&value); err != nil {
			return err
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("null fields are not allowed")
		}
	}
	if _, err = d.Token(); err != nil {
		return err
	}
	if _, err = d.Token(); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	for _, key := range required {
		if !seen[key] {
			return fmt.Errorf("missing %s", key)
		}
	}
	return json.Unmarshal(data, target)
}

func protectedFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || int(stat.Uid) != os.Geteuid() || info.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("unprotected file: %s", path)
	}
	return nil
}

func protectedPath(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("protected paths must be absolute")
	}
	for {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || (int(stat.Uid) != os.Geteuid() && stat.Uid != 0) {
			return fmt.Errorf("unprotected directory: %s", path)
		}
		// A sticky ancestor cannot replace a protected child owned by this UID.
		if info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0 {
			return fmt.Errorf("writable directory: %s", path)
		}
		if path == "/" {
			return nil
		}
		path = filepath.Dir(path)
	}
}
