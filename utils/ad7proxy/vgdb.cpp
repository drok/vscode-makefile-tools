#include <cstdio>
#include <cstdlib>
#include <unistd.h>
#include <fcntl.h>
#include <getopt.h>

#include "config.h"
#include <sys/wait.h>
#include <signal.h>

#include <string>
#include <string_view>
#include <sstream>
#include <iostream>
#include <fstream>
#include <regex>
#include <cassert>
#include <map>
#include "vgdb.h"
#include "gdb.h"

using namespace std;

// #define STOP_ON_FORK 1
#define AUTO_SWITCH_THREAD_1_ON_EXEC_CATCH
#define AUTO_SWITCH_THREAD_1_ON_THREAD_EXIT

void CmdFilterVgdb::InitializeDebugger()
{
    buf.append(GDB::INITIALIZATION);
    if (!schedule_multiple) {
        schedule_multiple = true;
        buf.append(GDB::SCHEDULE_MULTIPLE_ON);
    }
    select_channel::InitializeDebugger();
}

void
CmdFilterVgdb::onMatch(const string_view& in, const filter_it& match) {
    sendToConsole("sendToConsole() from CmdFilter.onMatch()", console);
    buf.append(in, match.it->position(), match.it->length());
}
string_view CmdFilterVgdb::filter(string_view input_buf)
{
    vector<filter_it> re_its = {
        // FILTER_INIT(input_buf, GDB_EXEC_CONTINUE),
        // FILTER_INIT(input_buf, GDB_EXEC_STEPS),
        // FILTER_INIT(input_buf, GDB_FILE_EXEC_AND_SYMBOLS),
    };
    if (!initialized) {
        InitializeDebugger();
        if (buf.size()) {
            auto filtered = filter_re(input_buf, re_its, buf);
            if (filtered == input_buf) {
                buf.append(filtered);
                return buf;
            } else {
                return filtered;
            }
        }
    }
    return filter_re(input_buf, re_its, buf);
}

void
OutFilterVgdb::onMatch(const string_view& in, const filter_it& match) {
    sendToConsole("sendToConsole() from OutFilter.onMatch()", buf);
    if (&match.filter == &GDB::INFERIOR_EXIT) {
        if (running) {
            // buf.append(in, match.it->position(), match.it->length());
            //V buf.append(GDB::THREAD_EXITED);
            assert(last_thread_group_exit && "last_thread_group_exit should have been set on thread-group-exited");
#ifdef AUTO_SWITCH_THREAD_1_ON_THREAD_EXIT
            sendTo("inferior 1", buf);
#endif
#if !defined(STOP_AT_EXEC)
            sendTo(GDB::EXEC_CONTINUE, buf);
#endif
            if (last_thread_group_exit != 1) // Don't send the "exited-normally" except when the debugged program ends
                return;
        }
    } else
    if (&match.filter == &GDB::INFERIOR_EXIT_W_ERROR) {
        auto m = get_matches(in, match);
        assert(m.size() == 2 && "Exactly 2 things captured (full string, exit-code)");
        // long exit_code = stol(m[1]);
        //V buf.append(GDB::THREAD_EXITED);
#ifdef AUTO_SWITCH_THREAD_1_ON_THREAD_EXIT
        sendTo("inferior 1", buf);
#endif
        if (last_thread_group_exit != 1) {
        // Don't send the "exited" event because the vgdb bridge does not expect it.
#if !defined(STOP_AT_EXEC)
            sendTo(GDB::EXEC_CONTINUE, buf);
#endif
            // FIXME: what if the debuggee ends with out exited-normally?
            return;
        }
    } else
    if (&match.filter == &GDB::INFERIOR_EXEC) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, pathname, thread id)");
        long thread = stol(m[2]);
        long group_id = group_ids[thread];
        auto pid = threads[thread];
        exec_threads[thread] = group_id;
        string remote_debugger;
        auto has_remote = getDebuggerVariable(pid, remote_debugger);
        buf.append("~\" ---ad7--- Executing " + m[1].str() + " as pid " + to_string(pid) +
        (has_remote ?
            (remote_debugger.size() ? " to debug remotely via " + remote_debugger : " without debugging") :
            ""
        ) + "\\n\"\n");

        int do_continue = 1;
        if (has_remote) {
            // buf_to_loopback.append("-target-detach\n");
//            if (GDB_8_2_CRASH_ON_THREAD_INFO_AFTER_DETACH)
//                buf_to_loopback.append("-thread-select 1\n");
            if (remote_debugger == "debug") { // stop at entry
                do_continue = true;
                if (!breakpoints_enabled) enableBreakpoints();
            } else if (remote_debugger == "break") { // stop on breakpoints
                if (!breakpoints_enabled) enableBreakpoints();
            } else if (remote_debugger != "detach") {
                remotes[group_id] = remote_debugger;
#ifdef DEBUG
                    "shell echo i" + to_string(group_id) + " has remote " + remote_debugger + "\n"
                sendToLoopback("shell echo i" + to_string(group_id) + " has remote " + remote_debugger, buf);
#endif
                /* remote_debugger is not sanitized - can lead to arbitrary execution
                 * but does it need to be sanitized? The user already has arbitrary execution priviledge
                 */
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR
                sendTo(GDB::SCHEDULE_MULTIPLE_ON, buf);
#endif
#ifndef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
                auto created_it = createdInferiors.emplace(group_id, INFERIOR_STATE_INIT_NEW);
                assert(created_it.second && "createdInferior should not yet exist");
#endif
                paused = true;

            } else {
                /* Empty DEBUGGER_URI means detach this process */
                sendTo("detach inferior " + to_string(group_id), buf);
            }
        }
        else if (breakpoints_enabled) {
            disableBreakpoints();
        }
        if (do_continue) {
#if !defined(STOP_AT_EXEC)
            // sendTo("next", buf);
#endif
#if defined(AUTO_SWITCH_THREAD_1_ON_EXEC_CATCH)
            sendTo("inferior 1", buf);
#endif
#if !defined(STOP_AT_EXEC)
            sendTo(GDB::EXEC_CONTINUE, buf);
#else
            buf.append(in, match.it->position(), match.it->length());
#endif
            return;
        }
        /* Remove stop notification; ad7 does not recognize stop on exec */
        // in.remove_prefix(match.it->length());
    }
    buf.append(in, match.it->position(), match.it->length());
    if (&match.filter == &GDB::FIRST_THREAD_EXIT) {
        if (running) {
            running = false;
        }
    } else
    if (&match.filter == &GDB::THREAD_GROUP_EXITED) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, thread group number, exit-code)");
        long id = stol(m[1]);
        // long exit_code = stol(m[2]);
        last_thread_group_exit = id;
    } else
/*
=thread-group-added,id="i2"
=thread-group-started,id="i2",pid="18748"
~"[New inferior 2 (process 18748)]\n"
=thread-created,id="2",group-id="i2"
~"process 18748 is executing new program: /usr/bin/qemu-x86_64\n"
=breakpoint-modified,bkpt={number="2",type="catchpoint",disp="keep",enabled="y",what="/usr/bin/qemu-x86_64",catch-type="exec",thread-groups=["i1"],times="2"}
~"[Switching to process 18748]\n"
~"\n"
~"Thread 2.1 \"qemu-x86_64\" hit Catchpoint 2 (exec'd /usr/bin/qemu-x86_64), 0x00007ffff7c8cc30 in _start () from /lib64/ld-linux-x86-64.so.2\n"
*stopped,reason="exec",disp="keep",bkptno="2",new-exec="/usr/bin/qemu-x86_64",frame={addr="0x00007ffff7c8cc30",func="_start",args=[],from="/lib64/ld-linux-x86-64.so.2"},
  thread-id="2",stopped-threads="all",core="3"
*/
    if (&match.filter == &GDB::THREAD_GROUP_ADDED) {
        auto m = get_matches(in, match);
        assert(m.size() == 2 && "Exactly 2 things is captured (full string, thread group number)");
        long id = stol(m[1]);
        groups.emplace(id, 0);
    } else
    if (&match.filter == &GDB::THREAD_GROUP_REMOVED) {
        auto m = get_matches(in, match);
        assert(m.size() == 2 && "Exactly 2 things is captured (full string, thread group number)");
        long id = stol(m[1]);
        groups.erase(id);
    } else
    if (&match.filter == &GDB::THREAD_GROUP_STARTED) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, thread group number, pid)");
        long id = stol(m[1]);
        long pid = stol(m[2]);
        groups[id] = pid;
    } else
    if (&match.filter == &GDB::THREAD_CREATED) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, thread group number, thread_group)");
        long id = stol(m[1]);
        long group_id = stol(m[2]);
        auto pid = threads[id] = groups[group_id];
        group_ids[id] = group_id;
        buf.append("~\" ---ad7--- Thread " + to_string(id) + " is pid " + to_string(pid) + "\\n\"\n");
        // sendTo("inferior 1", buf);
        sendTo(GDB::EXEC_CONTINUE, buf);
    } else
    if (&match.filter == &GDB::REMOTE_CONNECTED) {
        if (paused)
            paused = false;
    } else
    if (&match.filter == &GDB::ERROR) {
        if (paused) {
            paused = false;
        }
#ifdef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
    } else
    if (&match.filter == &GDB_ASYNC_STATUS_THREAD_RUNNING) {
        auto m = get_matches(in, match);
        assert(m.size() == 2 && "Exactly 2 things is captured (full string, thread id)");
        long id = stol(m[1]);
        auto group_it = exec_threads.find(id);
        if (group_it != exec_threads.end()) {
            auto remote = remotes.find(group_it->second);

            if (remote != remotes.end()) {
                // buf_to_loopback.append("-target-detach\n");
    //            if (GDB_8_2_CRASH_ON_THREAD_INFO_AFTER_DETACH)
    //                buf_to_loopback.append("-thread-select 1\n");
                assert(remote->second.size() && "should only store non-empty remotes");
                buf_to_loopback.append(
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR_PART_2
#ifdef SLOW_DOWN
                        "shell sleep 5\n"
#endif
                        "" + to_string(group_it->second + CMDBASE_ADD_INFERIOR) + "-add-inferior\n"
                        "" + to_string(group_it->second + CMDBASE_ADD_INFERIOR) + "-gdb-show annotate\n"
#ifdef SLOW_DOWN
                        "shell sleep 5\n"
#endif
#endif
                );
            }
        }
#endif
#ifdef STOP_ON_FORK
    } else
    if (&match.filter == &GDB_INFERIOR_FORK) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, newpid, thread id)");
        long newpid = stol(m[1]);
        long thread = stol(m[2]);
        // sendTo("inferior 1", buf);
        //sendTo("next", buf);
//c        sendTo("" + to_string(CMDBASE_CONTINUE_AFTER_FORK) +
//c                    "-exec-continue", buf);
#endif
    } else
    if (&match.filter == &GDB::INFERIOR_ADDED) {
        auto m = get_matches(in, match);
        assert(m.size() == 4 && "Exactly 4 things is captured (full string, exec_thread_group, thread group, connection num)");
        long exec_thread_group = stol(m[1]) - GDB_CMDBASE_ADD_INFERIOR;
        long remote_thread_group = stol(m[2]);
        remote_groups[exec_thread_group] = remote_thread_group;
    } else
    if (&match.filter == &GDB::DONE_WITH_NUM_VALUE) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, command ID, value)");
        long cmdid = stol(m[1]);
        if ((cmdid & GDB_CMDBASE_MASK) == GDB_CMDBASE_SELECT_INFERIOR) {
            long exec_thread_group = cmdid - GDB_CMDBASE_SELECT_INFERIOR;
            auto remote = remotes.find(exec_thread_group);
            assert(remote != remotes.end() && "inferior selected should correspond to a remote");
            assert(remote->second.size() && "should only store non-empty remotes");
            sendTo("shell sleep 0.2", buf);
            sendTo("9999915-target-select extended-remote " + remote->second, buf);
#ifdef SLOW_DOWN
            sendToLoopback("shell sleep 5", buf);
#endif
            remotes.erase(remote);
        } else
        if ((cmdid & GDB_CMDBASE_MASK) == GDB_CMDBASE_ADD_INFERIOR) {
            long exec_thread_group = cmdid - GDB_CMDBASE_ADD_INFERIOR;
#ifdef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
            auto remote_it = remote_groups.find(exec_thread_group);
            assert(remote_it != remote_groups.end() && "done is not related");
            auto remote = remotes.find(exec_thread_group);
            assert(remote != remotes.end() && "inferior selected should correspond to a remote");
            buf_to_loopback.append(
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR_PART_3
            sendToLoopback("inferior i" + to_string(remote_it->second), buf);
            sendToLoopback("" + to_string(exec_thread_group + CMDBASE_SELECT_INFERIOR) + "-gdb-show annotate", buf);
#endif
            sendToLoopback("shell echo timing barrier", buf);
#else
            auto created_it = createdInferiors.find(exec_thread_group);
            if (created_it != createdInferiors.end()) {
                created_it->second.created = 1;
                selectInferiorOnce(exec_thread_group);
            }
#endif
        } else
        {}
#ifndef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
    } else
    if (&match.filter == &GDB::ASYNC_STATUS_LIBRARY_LOADED) {
        /* This event is a hack to work around a race in gdb 14 and earlier
         * If the remote inferior is selected before the exec inferior loads,
         * the exec inferior is stopped.
         */
        auto m = get_matches(in, match);
        assert(m.size() == 2 && "Exactly 2 things is captured (full string, thread group id)");
        long exec_thread_group = stol(m[1]);
        auto created_it = createdInferiors.find(exec_thread_group);
        if (created_it != createdInferiors.end()) {
            created_it->second.libloaded = 1;
            selectInferiorOnce(exec_thread_group);
        }
#endif
    } else
    if (&match.filter == &GDB::VERSION_STR) {
        auto m = get_matches(in, match);
        assert(m.size() == 5 && "Exactly 5 things is captured (full string, major, minor, patch, build)");
        debuggerInfo.major = stol(m[1]);
        debuggerInfo.minor = stol(m[2]);
        debuggerInfo.patch = stol(m[3]);
        debuggerInfo.build = stol(m[4]);
        IdentifyDebugger();
    }
}

string_view OutFilterVgdb::filter(string_view input_buf)
{
    vector<filter_it> re_its = {
        FILTER_INIT(input_buf, GDB::FIRST_THREAD_EXIT),
        FILTER_INIT(input_buf, GDB::INFERIOR_EXIT),
        FILTER_INIT(input_buf, GDB::INFERIOR_EXIT_W_ERROR),
        FILTER_INIT(input_buf, GDB::THREAD_GROUP_ADDED),
        FILTER_INIT(input_buf, GDB::THREAD_GROUP_EXITED),
        FILTER_INIT(input_buf, GDB::THREAD_GROUP_REMOVED),
        FILTER_INIT(input_buf, GDB::THREAD_GROUP_STARTED),
        FILTER_INIT(input_buf, GDB::THREAD_CREATED),
        FILTER_INIT(input_buf, GDB::INFERIOR_EXEC),
#ifdef STOP_ON_FORK
        FILTER_INIT(input_buf, GDB::INFERIOR_FORK),
#endif
        FILTER_INIT(input_buf, GDB::DONE_WITH_NUM_VALUE),
        FILTER_INIT(input_buf, GDB::ERROR),
        FILTER_INIT(input_buf, GDB::INFERIOR_ADDED),
        FILTER_INIT(input_buf, GDB::ASYNC_STATUS_THREAD_RUNNING),
        FILTER_INIT(input_buf, GDB::ASYNC_STATUS_LIBRARY_LOADED),
        FILTER_INIT(input_buf, GDB::REMOTE_CONNECTED),
    };
    if (!identified) {
        re_its.emplace_back(
            FILTER_INIT(input_buf, GDB::VERSION_STR)
        );
    }
    return filter_re(input_buf, re_its, buf);
}

void OutFilterVgdb::enableBreakpoints()
{
    sendTo(GDB::BREAKPOINTS_ENABLE, buf);
    breakpoints_enabled = true;
}

void OutFilterVgdb::disableBreakpoints()
{
    sendTo(GDB::BREAKPOINTS_DISABLE, buf);
    breakpoints_enabled = false;
}
