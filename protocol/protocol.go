package protocol

import _ "embed"

const Version = 1

//go:embed client.schema.json
var Schema []byte
