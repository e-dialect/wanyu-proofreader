package main

import (
	"fangji/backend/ocrengine"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	secret := os.Getenv("OCR_WORKER_TOKEN")
	if len(secret) < 32 {
		log.Fatal("OCR_WORKER_TOKEN must contain at least 32 characters")
	}
	server := &http.Server{Addr: ":8091", Handler: ocrengine.Handler(secret, 90*time.Second, ocrengine.Recognize), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 95 * time.Second, WriteTimeout: 100 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	log.Fatal(server.ListenAndServe())
}
