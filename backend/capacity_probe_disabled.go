//go:build !capacityprobe

package main

import "github.com/pocketbase/pocketbase/core"

// Production builds expose no profiling route and ignore profiling environment.
func registerCapacityProbe(core.App) {}
