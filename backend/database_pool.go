package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// PocketBase retains an independent one-connection writer for each database.
// These limits bound concurrent readers, not transactional writer connections.
// SQLite's per-connection cache is not fully reflected in Go HeapAlloc, so the
// upstream 120/20 reader ceiling permits cache budgets beyond our shared host.
// Actual open connections are measured separately. This is not an RSS cap.
func databasePoolConfig(getenv func(string) string) (pocketbase.Config, error) {
	c := pocketbase.Config{DataMaxOpenConns: 8, DataMaxIdleConns: 4, AuxMaxOpenConns: 2, AuxMaxIdleConns: 2}
	for _, v := range []struct {
		name     string
		value    *int
		min, max int
	}{
		{"FANGJI_DB_DATA_MAX_OPEN", &c.DataMaxOpenConns, 2, 120},
		{"FANGJI_DB_DATA_MAX_IDLE", &c.DataMaxIdleConns, 1, 120},
		{"FANGJI_DB_AUX_MAX_OPEN", &c.AuxMaxOpenConns, 1, 20},
		{"FANGJI_DB_AUX_MAX_IDLE", &c.AuxMaxIdleConns, 1, 20},
	} {
		raw := strings.TrimSpace(getenv(v.name))
		if raw == "" {
			continue
		}
		number, err := strconv.Atoi(raw)
		if err != nil || number < v.min || number > v.max {
			return pocketbase.Config{}, fmt.Errorf("%s must be an integer in %d..%d", v.name, v.min, v.max)
		}
		*v.value = number
	}
	// PocketBase treats <=0 as its upstream default, not a disabled/empty pool.
	if c.DataMaxIdleConns > c.DataMaxOpenConns || c.AuxMaxIdleConns > c.AuxMaxOpenConns {
		return pocketbase.Config{}, fmt.Errorf("database idle connection limits must not exceed open limits")
	}
	return c, nil
}

type databasePoolSample struct {
	MaxOpen           int   `json:"max_open"`
	Open              int   `json:"open"`
	InUse             int   `json:"in_use"`
	Idle              int   `json:"idle"`
	WaitCount         int64 `json:"wait_count"`
	WaitDurationMS    int64 `json:"wait_duration_ms"`
	MaxIdleClosed     int64 `json:"max_idle_closed"`
	MaxIdleTimeClosed int64 `json:"max_idle_time_closed"`
}

// Stats executes no SQL and acquires no connection. Names are fixed, counters
// cumulative since startup; no query text, credentials or user data is included.
func databasePoolSamples(app core.App) map[string]databasePoolSample {
	result := make(map[string]databasePoolSample, 4)
	for name, builder := range map[string]dbx.Builder{"data_read": app.ConcurrentDB(), "data_write": app.NonconcurrentDB(), "aux_read": app.AuxConcurrentDB(), "aux_write": app.AuxNonconcurrentDB()} {
		if db, ok := builder.(*dbx.DB); ok {
			s := db.DB().Stats()
			result[name] = databasePoolSample{MaxOpen: s.MaxOpenConnections, Open: s.OpenConnections, InUse: s.InUse, Idle: s.Idle, WaitCount: s.WaitCount, WaitDurationMS: s.WaitDuration.Milliseconds(), MaxIdleClosed: s.MaxIdleClosed, MaxIdleTimeClosed: s.MaxIdleTimeClosed}
		}
	}
	return result
}
