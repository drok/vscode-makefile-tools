#!/bin/bash

set -x
set -o errexit
outfile=$(mktemp)

cat <<EOF | ${DEBUGGER:-} ./ad7proxy awk '{print}' >$outfile
aaa
-exec-continue
ccc
-exec-continue
ddd
EOF

diff -u $outfile - <<EOF
aaa
-gdb-set schedule-multiple on
-exec-continue
ccc
-exec-continue
ddd
EOF
