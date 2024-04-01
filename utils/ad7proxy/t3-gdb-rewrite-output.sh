#!/bin/bash

set -x
set -o errexit
outfile=$(mktemp)

cat <<EOF | ${DEBUGGER:-} ./ad7proxy awk '
{print}
/^cmd1$/ { print "*stopped,reason=\"exited-normally\",\"blah\""}
/^cmd2$/ { print "=thread-group-exited,id=\"i1\""}
/^cmd2$/ { print "resp1"}
' >$outfile
aaa
cmd1
ccc1
cmd2
ccc2
cmd1
ddd
EOF

diff -u - $outfile <<EOF
aaa
cmd1
*stopped,reason="subprocess-fin"
ccc1
cmd2
=thread-group-exited,id="i1"
resp1
ccc2
cmd1
*stopped,reason="exited-normally","blah"
ddd
EOF
