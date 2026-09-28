package api

import "testing"

func TestHandlerShort(t *testing.T) {
	if testing.Short() {
		t.Skip("slow")
	}
}
