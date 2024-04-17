#!/bin/bash

set -x
set -o errexit
outfile=$(mktemp)

cat <<EOF | ${DEBUGGER:-} ./ad7proxy awk '
{print ; fflush(); }
/^cmd1$/ { print "*stopped,reason=\"exited-normally\",\"blah\"" ; fflush(); }
/^cmd2$/ { print "=thread-group-exited,id=\"i1\"" ; fflush(); }
/^cmd2$/ { print "resp1" ; fflush(); }
/^cmd3$/ { print "=thread-group-added,id=\"i5\"" ; fflush(); }
/^cmd3$/ { print "=thread-group-started,id=\"i5\",pid=\"18748\"" ; fflush(); }
/^cmd3$/ { print "=thread-created,id=\"22\",group-id=\"i5\"" ; fflush(); }
/^cmd3$/ { print "*stopped,reason=\"exec\",disp=\"keep\",bkptno=\"3\",new-exec=\"/usr/bin/qemu-x86_64\",frame={addr=\"0x00007ffff7c8cc30\",func=\"_start\",args=[],from=\"/lib64/ld-linux-x86-64.so.2\"},thread-id=\"22\",stopped-threads=\"all\",core=\"7\"" ; fflush(); }
' >$outfile
aaa
cmd3
ccc
EOF

diff -u - $outfile <<EOF
aaa
cmd3
=thread-group-added,id="i5"
=thread-group-started,id="i5",pid="18748"
=thread-created,id="22",group-id="i5"
~"Thread 22 is pid 18748\n"
*stopped,reason="exec",disp="keep",bkptno="3",new-exec="/usr/bin/qemu-x86_64",frame={addr="0x00007ffff7c8cc30",func="_start",args=[],from="/lib64/ld-linux-x86-64.so.2"},thread-id="22",stopped-threads="all",core="7"
~"Executing /usr/bin/qemu-x86_64 as pid 18748\n"
ccc
EOF

