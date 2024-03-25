#!/bin/bash

set -x

dir=$(dirname $0)
ppid=
if "$2" --version | egrep -q 'GNU gdb .* 8\.2' ; then
    # Set the parent PID if gdb can get stuck on 100% CPU
    ppid=$$
fi
{
    # multiple is off by default
    awk '/^-exec-continue$/ {
            if (!multiple) {
                print "-gdb-set schedule-multiple on"
                multiple = 1
            }
            print "info infe"
            # Because OpenAD7 does not send a thread-select before continue
            print "-thread-select 1"
        }
        multiple && /^[[:digit:]]+-exec-(next|step|finish)/ {
            multiple = 0
            print "-gdb-set schedule-multiple off"
        }
        { print ; fflush(); }
    '
    if [ "$ppid" != "" ] ; then
        { sleep 2 ; kill -9 -$ppid ; } >/dev/null
    fi
} |
"$2" \
    -x "$dir/../include/skipfile" \
    -ex "source $dir/forked-child-debug.py" \
    -ex "set args -c \"exec $4\"" \
    "$1" "$5" sh |
    awk '/^\*stopped,reason="exited-normally"/ {
        if (!FSM) {
            print "*stopped,reason=\"subprocess-fin\""
            fflush()
            next
        }
    }
    BEGIN { FSM = 0 ; running = 0}
    /^=thread-group-exited,id="i1"/ { running = 0 ; FSM = 1 }
    { print ; fflush(); }'
