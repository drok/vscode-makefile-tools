#!/bin/bash

# See https://stackoverflow.com/a/77004470/7859025

[ -x "$3" ] && "$3" --mode=execute "$2" \
     -x "$(dirname $0)/../include/skipfile" -ex "set solib-absolute-prefix /dev/null" "$1" "$5" "$4"
