#!/bin/bash

set -x
set -o errexit
outfile=$(mktemp)

cat <<EOF | ./ad7proxy awk '{print}' >$outfile
aaa
bbb
ccc
EOF

diff -u $outfile - <<EOF
aaa
bbb
ccc
EOF
