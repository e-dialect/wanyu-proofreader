package main

import (
	"bytes"
	"strings"
	"testing"
)

// inspectGB18030 的严格结构校验单测：合法 GB18030/GBK 通过（偏移 -1），
// 损坏/截断字节返回首个非法字节的绝对偏移。
func TestInspectGB18030(t *testing.T) {
	tests := []struct {
		name      string
		input     []byte
		badOffset int64 // -1 = 全部合法
	}{
		{name: "ascii", input: []byte("hello"), badOffset: -1},
		{name: "gb18030 双字节「中文」", input: []byte{0xd6, 0xd0, 0xce, 0xc4}, badOffset: -1},
		{name: "gbk 欧元扩展 0x80", input: []byte{0x80}, badOffset: -1},
		{name: "gb18030 四字节结构", input: []byte{0x81, 0x30, 0x81, 0x30}, badOffset: -1},
		// #369 点名的损坏/截断字节
		{name: "损坏 0xff", input: []byte{0xff}, badOffset: 0},
		{name: "截断 0x81", input: []byte{0x81}, badOffset: 0},
		{name: "损坏 0x81 0x20", input: []byte{0x81, 0x20}, badOffset: 0},
		{name: "损坏 0xff 0xff", input: []byte{0xff, 0xff}, badOffset: 0},
		{name: "前导+非法尾 0x81 0x7f", input: []byte{0x81, 0x7f}, badOffset: 0},
		{name: "截断四字节 0x81 0x30 0x81", input: []byte{0x81, 0x30, 0x81}, badOffset: 0},
		// 偏移非 0 的用例，验证偏移跟踪正确
		{name: "前缀 ASCII 后损坏", input: []byte{0x61, 0xff}, badOffset: 1},
		{name: "中缀损坏", input: []byte{0xd6, 0xd0, 0xff}, badOffset: 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			offset, err := inspectGB18030(bytes.NewReader(tt.input))
			if err != nil {
				t.Fatalf("inspectGB18030(% X) 返回错误: %v", tt.input, err)
			}
			if offset != tt.badOffset {
				t.Fatalf("inspectGB18030(% X) = 偏移 %d, want %d", tt.input, offset, tt.badOffset)
			}
		})
	}
}

// decodedCSVReader 端到端：损坏/截断编码应拒绝且报错含字节定位，合法 UTF-8/GB18030 应通过。
func TestDecodedCSVReaderRejectsCorruptEncoding(t *testing.T) {
	corrupt := [][]byte{
		{0xff},
		{0x81},
		{0x81, 0x20},
		{0xff, 0xff},
	}
	for _, c := range corrupt {
		_, _, err := decodedCSVReader(bytes.NewReader(c))
		if err == nil {
			t.Fatalf("decodedCSVReader(% X) 应报错但没有", c)
		}
		if !strings.Contains(err.Error(), "字节") {
			t.Fatalf("decodedCSVReader(% X) 报错信息应含字节定位，实际：%v", c, err)
		}
	}

	valid := []struct {
		name string
		data []byte
		enc  string
	}{
		{name: "utf8", data: []byte{0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87}, enc: "UTF-8"},
		{name: "gb18030", data: []byte{0xd6, 0xd0, 0xce, 0xc4}, enc: "GB18030"},
	}
	for _, v := range valid {
		if _, enc, err := decodedCSVReader(bytes.NewReader(v.data)); err != nil {
			t.Fatalf("[%s] decodedCSVReader(% X) 不应报错: %v", v.name, v.data, err)
		} else if enc != v.enc {
			t.Fatalf("[%s] 编码 = %q, want %q", v.name, enc, v.enc)
		}
	}
}
