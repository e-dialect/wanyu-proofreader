// delivery-replay verifies and reconstructs an E delivery without a W database.
package main

import (
	"fmt"
	"os"

	"fangji/backend/reviewbundle"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "用法：delivery-replay 包.zip 已独立记录的SHA256 重放输出.zip")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out, snapshot, err := reviewbundle.ReplayDelivery(data, os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = os.WriteFile(os.Args[3], out, 0600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("重放一致：%d 条采用正文，来源 %s/%s/%s；发布仍须人工决定。\n", len(snapshot.Entries), snapshot.SourceSystem, snapshot.SourceID, snapshot.SourceVersion)
}
