#!/bin/bash

set -x
dir=$(dirname $0)
# gdbserver :9995
strace -s 2800 -o /tmp/ad7trace \
 "$dir/../utils/ad7proxy/build/Debug/ad7proxy" "$2" \
     -x "$dir/../include/skipfile" \
     -l 100 \
     -ex "source $dir/forked-child-debug.py" \
     -ex "catch fork" \
     -ex "catch exec" \
     -ex "set detach-on-fork off" \
     -ex "set follow-fork-mode child" \
     -ex "set trace-commands on" \
     -ex "set args -c \"exec $4\"" \
     -ex "set tcp connect-timeout 1" \
     "$5" "$1" sh
