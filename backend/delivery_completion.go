package main

import (
	"fmt"
	"path/filepath"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/require"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

// Use the same completion function as verification-export, including current
// source basis, revalidation evidence, holds and blocking reports. Keep one VM
// per snapshot transaction, bound to that transaction's app; never share a VM
// between concurrent requests or ask another HTTP request to read its state.
func newDeliveryCompletion(app core.App, hooksDir string) (func(*core.Record) (bool, error), error) {
	// Match jsvm's default and honor the server's explicit --hooksDir as well.
	if hooksDir == "" {
		hooksDir = filepath.Join(app.DataDir(), "..", "pb_hooks")
	}
	absHooksDir, err := filepath.Abs(hooksDir)
	if err != nil {
		return nil, err
	}
	vm := goja.New()
	new(require.Registry).Enable(vm)
	jsvm.BindCore(vm)
	jsvm.BindSecurity(vm)
	if err := vm.Set("__hooks", absHooksDir); err != nil {
		return nil, err
	}
	value, err := vm.RunString(`(function(dao, page) {
		return require(__hooks + "/lib/source_fidelity.js").completion(dao, page).business_complete === true;
	})`)
	if err != nil {
		return nil, err
	}
	completion, ok := goja.AssertFunction(value)
	if !ok {
		return nil, fmt.Errorf("source completion evaluator is unavailable")
	}
	return func(page *core.Record) (bool, error) {
		result, err := completion(goja.Undefined(), vm.ToValue(app), vm.ToValue(page))
		if err != nil {
			return false, err
		}
		return result.ToBoolean(), nil
	}, nil
}
