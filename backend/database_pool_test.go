package main

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func TestDatabasePoolConfiguration(t *testing.T) {
	c, err := databasePoolConfig(func(string) string { return "" })
	if err != nil || c.DataMaxOpenConns != 8 || c.DataMaxIdleConns != 4 || c.AuxMaxOpenConns != 2 || c.AuxMaxIdleConns != 2 {
		t.Fatalf("unexpected defaults: %+v %v", c, err)
	}
	for _, values := range []map[string]string{
		{"FANGJI_DB_DATA_MAX_OPEN": "0"}, {"FANGJI_DB_DATA_MAX_OPEN": "1"}, {"FANGJI_DB_DATA_MAX_OPEN": "121"},
		{"FANGJI_DB_DATA_MAX_IDLE": "0"}, {"FANGJI_DB_DATA_MAX_IDLE": "9"}, {"FANGJI_DB_AUX_MAX_OPEN": "-1"},
		{"FANGJI_DB_AUX_MAX_OPEN": "21"}, {"FANGJI_DB_AUX_MAX_IDLE": "0"}, {"FANGJI_DB_AUX_MAX_IDLE": "3"},
		{"FANGJI_DB_DATA_MAX_OPEN": "1.5"}, {"FANGJI_DB_AUX_MAX_OPEN": "not-number"},
	} {
		if _, err := databasePoolConfig(func(key string) string { return values[key] }); err == nil {
			t.Errorf("accepted invalid config: %v", values)
		}
	}
	values := map[string]string{"FANGJI_DB_DATA_MAX_OPEN": "120", "FANGJI_DB_DATA_MAX_IDLE": "15", "FANGJI_DB_AUX_MAX_OPEN": "20", "FANGJI_DB_AUX_MAX_IDLE": "3"}
	c, err = databasePoolConfig(func(key string) string { return values[key] })
	if err != nil || c.DataMaxOpenConns != 120 || c.AuxMaxOpenConns != 20 {
		t.Fatalf("explicit control profile: %+v %v", c, err)
	}
}

func TestBoundedDatabasePoolsKeepIndependentReadersAndTransactions(t *testing.T) {
	values := map[string]string{"FANGJI_DB_DATA_MAX_OPEN": "2", "FANGJI_DB_DATA_MAX_IDLE": "1", "FANGJI_DB_AUX_MAX_OPEN": "1", "FANGJI_DB_AUX_MAX_IDLE": "1"}
	c, err := databasePoolConfig(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	c.DefaultDataDir = t.TempDir()
	app := pocketbase.NewWithConfig(c)
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	defer app.ResetBootstrapState()
	if _, err := app.NonconcurrentDB().NewQuery("CREATE TABLE pool_test(id INTEGER PRIMARY KEY,value INTEGER)").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.NonconcurrentDB().NewQuery("INSERT INTO pool_test VALUES(1,0)").Execute(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Hold one reader. Nested txApp reads use the writer transaction; a second
	// independent reader must remain available and see only committed data.
	reader, err := app.ConcurrentDB().(*dbx.DB).DB().Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = app.RunInTransaction(func(tx core.App) error {
		if _, err := tx.DB().NewQuery("UPDATE pool_test SET value=1 WHERE id=1").WithContext(ctx).Execute(); err != nil {
			return err
		}
		return tx.RunInTransaction(func(nested core.App) error {
			var own, independent int
			if err := nested.DB().NewQuery("SELECT value FROM pool_test WHERE id=1").WithContext(ctx).Row(&own); err != nil {
				return err
			}
			if err := app.ConcurrentDB().NewQuery("SELECT value FROM pool_test WHERE id=1").WithContext(ctx).Row(&independent); err != nil {
				return err
			}
			if own != 1 || independent != 0 {
				return fmt.Errorf("transaction isolation own=%d independent=%d", own, independent)
			}
			return nil
		})
	})
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	failures := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 0; n < 5; n++ {
				var value int
				if err := app.ConcurrentDB().NewQuery("SELECT value FROM pool_test WHERE id=1").WithContext(ctx).Row(&value); err != nil {
					failures <- err
					return
				}
				if err := app.RunInTransaction(func(tx core.App) error {
					_, err := tx.DB().NewQuery("UPDATE pool_test SET value=value+1 WHERE id=1").WithContext(ctx).Execute()
					return err
				}); err != nil {
					failures <- err
					return
				}
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	var final int
	if err := app.ConcurrentDB().NewQuery("SELECT value FROM pool_test WHERE id=1").WithContext(ctx).Row(&final); err != nil {
		t.Fatal(err)
	}
	if final != 161 {
		t.Fatalf("lost writes: %d", final)
	}
	stats := databasePoolSamples(app)
	for name, want := range map[string]int{"data_read": 2, "data_write": 1, "aux_read": 1, "aux_write": 1} {
		if stats[name].MaxOpen != want || stats[name].Open > want {
			t.Fatalf("unbounded %s: %+v", name, stats[name])
		}
	}
}
