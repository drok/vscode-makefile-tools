#!/bin/bash

# set -x
# echo args: $@ >> /tmp/gdb.log
# echo '=ZZZZZZZZZZZZZZ,arg=555'
dir=$(dirname $0)
if false ; then
while read line ; do
    if [[ "$line" =~ "ZZZZ" ]] ; then
        echo '=ZZZZZZZZZZZZZZ,arg=555'
    else
        echo $line
    fi
done < <("$2" \
     -x "$dir/../include/skipfile" \
     -ex "source $dir/forked-child-debug.py" \
     -ex "set args -c \"exec $4\"" \
     "$1" "$5" sh)

else

"$2" \
     -x "$dir/../include/skipfile" \
     -ex "source $dir/forked-child-debug.py" \
     -ex "set args -c \"exec $4\"" \
     "$1" "$5" sh

fi