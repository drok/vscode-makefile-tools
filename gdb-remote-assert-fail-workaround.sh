#!/bin/bash

CONNECT_TIMEOUT=1
DEBUG_TCP_PORT=9999
SLEEP_PER_GDB_CMD=0.1

if [[ ${1:-none} == "--no-core" ]] ; then
    # gdb will crash but I don't want a core file
    ulimit -c 0
fi

MYPID=$$
if [[ ${1:-none} == "--workaround" ]] ; then
    # Enables the workaround to allow this test to pass
    WORKAROUND_ENABLE="set non-stop on"$'\n'
    WORKAROUND_DISABLE="set non-stop off"$'\n'
    shift
else
    WORKAROUND_ENABLE=
    WORKAROUND_DISABLE=
fi

DEBUGGED_PROGRAM="/bin/sh -c 'echo Hello ; sleep 1; echo Goodbye'"
case ${1:-qemu} in 
    qemu)
        DEBUGGER=`which qemu-x86_64`
        DEBUGGER_ARGS="-g $DEBUG_TCP_PORT $DEBUGGED_PROGRAM"
        EXEC_CONTINUE=""
        REMOTE_ADDR="127.0.0.1:$DEBUG_TCP_PORT"
        REMOTE_INFERIOR=2
        # With non-stop workaround:
        # 15:27:06.275739 &"target extended-remote 127.0.0.1:9999\n"
        # 15:27:06.275804 ~"+target extended-remote 127.0.0.1:9999\n"
        # 15:27:06.276321 ~"Remote debugging using 127.0.0.1:9999\n"
        # 15:27:06.319046 &"Non-stop mode requested, but remote does not support non-stop\n"
        # 15:27:06.319234 ^error,msg="Non-stop mode requested, but remote does not support non-stop"
        # if [[ ${WORKAROUND_ENABLE:+isset} ]] ; then
        #     WORKAROUND_ENABLE="set scheduler-locking off"$'\n'
        #     WORKAROUND_DISABLE="set scheduler-locking replay"$'\n'
        # fi
        ;;
    gdbserver)
        DEBUGGER=`which gdbserver`
        DEBUGGER_ARGS="--debug --remote-debug :$DEBUG_TCP_PORT $DEBUGGED_PROGRAM"
        EXEC_CONTINUE="-exec-continue"$'\n'"-exec-continue"$'\n'"-exec-continue"$'\n'
        REMOTE_ADDR="127.0.0.1:$DEBUG_TCP_PORT"
        REMOTE_INFERIOR=3
        ;;
    valgrind)
        DEBUGGER="/bin/sh"
        DEBUGGER_ARGS="-c \"exec $(which valgrind) --vgdb=full --vgdb-error=0 $DEBUGGED_PROGRAM\""
        EXEC_CONTINUE="-exec-continue"$'\n'"-exec-continue"$'\n'"-exec-continue"$'\n'
        REMOTE_ADDR="| vgdb"
        REMOTE_INFERIOR=2
        # with non-stop workaround:
        # 15:41:02.650226 &"target extended-remote | vgdb\n"
        # 15:41:02.650285 ~"+target extended-remote | vgdb\n"
        # 15:41:02.651019 ~"Remote debugging using | vgdb\n"
        # 15:41:02.654607 &"relaying data between gdb and process 13822\n"
        # 15:41:02.754796 &"Non-stop mode requested, but remote does not support non-stop\n"
        # 15:41:02.754973 ^error,msg="Non-stop mode requested, but remote does not support non-stop"
        # and eventually... valgrind segaults:
        # 15:41:02.935084 *stopped,reason="signal-received",signal-name="SIGSEGV",signal-meaning="Segmentation fault",frame={addr="0x0000000802cedfa9",func="??",args=[],arch="i386:x86-64"},thread-id="1",stopped-threads="all",core="0"        
        ;;
esac

# If this script runs as root, show the debug packets on the loopback interface
if [[ $UID == 0 ]] ; then
(
    tcpdump -nni lo tcp port $DEBUG_TCP_PORT
) &
TCPDUMP_PID=$!
fi
# -exec-continue --thread-group i1
# -exec-continue --thread-group i1
# -exec-continue --thread-group i1

# cat <<-EOF | awk '{print; fflush(); system("sleep 0.2");}' | gdb -n --interpreter=mi -ex "set args -g 9999 /bin/sh -c \"echo Hello ; sleep 1; echo Goodbye\"" $QEMU
cat <<-EOF | awk '{print; fflush(); system("sleep '$SLEEP_PER_GDB_CMD'");}' | gdb -n --interpreter=mi -ex "set args $DEBUGGER_ARGS" $DEBUGGER | ts '%H:%M:%.S'
set confirm off
set logging enabled on
set trace-commands on
set mi-async on
set detach-on-fork off
set follow-fork-mode parent
set pagination off
set auto-solib-add on
set stop-on-solib-events 0
set schedule-multiple on
set tcp connect-timeout $CONNECT_TIMEOUT
echo no --- catch fork
catch exec
-exec-run
$EXEC_CONTINUE-add-inferior
info infe
infe $REMOTE_INFERIOR
info infe
show architecture
set architecture i386:x86-64:intel
shell pstree -apl $MYPID
file /bin/sh
${WORKAROUND_ENABLE}target extended-remote $REMOTE_ADDR
${WORKAROUND_DISABLE}info infe
-exec-continue --thread-group i1
EOF

if [[ $UID == 0 ]] ; then
    kill $TCPDUMP_PID
    wait
fi
