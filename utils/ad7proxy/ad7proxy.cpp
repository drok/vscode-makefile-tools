#include <cstdio>
#include <cstdlib>
#include <unistd.h>
#include <fcntl.h>

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

/* TODO : Detect GDB version and only do this when needed
 * harmless to do it unnecessarily
 */
#define GDB_8_2_CRASH_ON_THREAD_INFO_AFTER_DETACH true

using namespace std;

struct filter_edit {
    /* Regular Expression to match */
    regex     re;
    #define   reopts (regex::optimize)
};

enum xfer_state {
    CLOSED = 0,
    PASSTHROUGH = 1,
    LOOPBACK = 2,
    INITIALIZE = 3,
};

struct DebuggerInfo {
    /* Debugger version */
    long major, minor, patch, build;
};

typedef regex_iterator<string_view::iterator> reit_t;
struct filter_it {
    /* Filter definition, including replacement string */
    const filter_edit     &filter;

    /* regex iterator for this filter */
    reit_t          it;
};
#define FILTER_INIT(b,f) filter_it{ f, regex_iterator<string_view::iterator>(b.begin(), b.end(), f.re), }

class select_channel {
    public:
        select_channel(int ifd, int ofd,
            fd_set &write_fdset,
            fd_set &read_fdset,
            int &nfd) :
            ifd(ifd),
            ofd(ofd),
            write_fdset(write_fdset),
            read_fdset(read_fdset),
            nfd(nfd),
            paused(false),
            initialized(false),
            identified(false),
            closing(false)
        {}
        int ifd, ofd;
        fd_set &write_fdset, &read_fdset;
        int &nfd;

        /* tranfer data from in to out, filtering
         * return : 0 if input has closed
         * 1 if transfer is normal
         * 2 if there is data to be sent back to the child (loopback)
         */
        xfer_state xfer();
        /*
         * Tranfer from in to out. If there is data to be looped back,
         * send it to the loopback channel
         * return non-zero if normal
         * 0 if closed
         */
        xfer_state xfer(select_channel &loopback);
        virtual string_view filter(string_view v);
        virtual string_view filter_re(string_view v, vector<filter_it> &re_its, string &buf);
        std::match_results<std::string_view::const_iterator> get_matches(const string_view& in, const filter_it& match);
        virtual void out(string_view& v);
        virtual void onMatch(const string_view& in, const filter_it& match);
        virtual void IdentifyDebugger();
        virtual void InitializeDebugger();

    private:
        string_view buf_to_send;
        char buf_to_parent[BUFSIZ];

    protected:
        /* Data to return to the parent*/
        bool paused;
        bool initialized;
        bool identified;
        DebuggerInfo debuggerInfo;
        string buf_to_loopback;
        string_view view_to_loopback;

    private:
        bool closing;
};

void
select_channel::InitializeDebugger()
{
    initialized = true;
}

void
select_channel::IdentifyDebugger()
{
    identified = true;
}

xfer_state
select_channel::xfer(select_channel& loopback)
{
    auto res = xfer();
    switch (res) {
        case LOOPBACK:
            view_to_loopback = buf_to_loopback;
            loopback.out(view_to_loopback);
            buf_to_loopback.clear();
            break;
    }
    return res;
}

xfer_state
select_channel::xfer()
{
    ssize_t buf_to_slave_len, buf_to_parent_len;
    if (FD_ISSET(ifd, &read_fdset)) {  /* Read from child, start writing to parent */
        buf_to_parent_len = read(ifd, buf_to_parent, sizeof(buf_to_parent));
        if (!buf_to_parent_len) {
            /* Closed */
            FD_CLR(ifd, &read_fdset);
//            FD_CLR(ofd, &write_fdset);
            close(ifd);
            close(ofd);
            closing = true;
        } else if (buf_to_parent_len < 0) {
            // interrupted ... continue
            // FD_CLR(ifd, &read_fdset); 
            return CLOSED;
        } else {
            string_view data_in(buf_to_parent, buf_to_parent_len);
            buf_to_send = filter(data_in);
            if(!paused) {
                ssize_t r = write(ofd, buf_to_send.data(), buf_to_send.size());
                if (r < 0) {
                    close(ifd);
    //                FD_CLR(ifd, &read_fdset);
                    closing = true;
                } else {
                    if (r != buf_to_send.size()) {
                        fsync(ofd);
    //                FD_CLR(ifd, &read_fdset);
    //                FD_SET(ofd, &write_fdset);
                    }
                    buf_to_send.remove_prefix(r);
                }
            }
        }
    } else if (FD_ISSET(ofd, &write_fdset)) { /* continue writing to parent */
        ssize_t r = write(ofd, buf_to_send.data(), buf_to_send.size());
        if (r < 0) {
//            FD_CLR(ofd, &write_fdset);
//            FD_CLR(ifd, &read_fdset);
            close(ifd);
            close(ofd);
            closing = true;
        } else {
            fsync(ofd);
            buf_to_send.remove_prefix(r);
            if (r == buf_to_send.size()) {
                if (closing) {
                    FD_CLR(ofd, &write_fdset);
                    close(ofd);
                }
    //            FD_SET(ifd, &read_fdset);
            }
        }
    } else if (!closing) {
        if (buf_to_send.size())
            FD_SET(ofd, &write_fdset);
        else
            FD_SET(ifd, &read_fdset);
    }
    return !closing ? (!!buf_to_loopback.size() ? LOOPBACK : PASSTHROUGH) : CLOSED;
}

void
select_channel::out(string_view& v)
{
    if (!closing) {
        auto sentlen = write(ofd, v.data(), v.size());
        if (!sentlen) {
            /* closed */
            FD_CLR(ifd, &read_fdset);
            close(ifd);
            close(ofd);
            closing = true;
        } else if (sentlen < 0)
            // interrupted
            return;
        else {
            if (sentlen != v.size()) {
            }
            v.remove_prefix(sentlen);
        }
    }
}

string_view
select_channel::filter(string_view v) {
    return v;
}

#define WRITE_END 1
#define READ_END 0

class CmdFilter : public select_channel {
    public:
        CmdFilter(int ifd, int ofd,
            fd_set &write_fdset,
            fd_set &read_fdset,
            int &nfd) :
            select_channel(ifd, ofd, write_fdset, read_fdset, nfd),
            schedule_multiple(false) {

            }
        virtual string_view filter(string_view v) override;
        void InitializeDebugger() override;
    private:
        void onMatch(const string_view& in, const filter_it& match) override;

        string buf;
        bool schedule_multiple;
};

class OutFilter : public select_channel {
    public:
        OutFilter(
            const char *debugged_program,
            int ifd, int ofd,
            fd_set &write_fdset,
            fd_set &read_fdset,
            int &nfd) :
            select_channel(ifd, ofd, write_fdset, read_fdset, nfd),
            debugged_program(debugged_program),
            running(true) {}
        virtual string_view filter(string_view v) override;
    private:
        void onMatch(const string_view& in, const filter_it& match) override;
#ifndef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
        /* at least up to gdb 14, if the remote inferior is selected before the
         * exec inferior loads libraries, the exec inferior remains stopped.
         * This workaround ensures the inferior is selected after either
         * the remote inferior is created, or the first library of the exec inferior
         * is loaded.
         */
        struct CreatedInferiorState {
            unsigned created : 1;
            unsigned libloaded : 1;
            unsigned selected : 1;
            unsigned added : 1;
        };
        #define INFERIOR_STATE_INIT_NEW CreatedInferiorState{0}
        map<long /* group-id */, CreatedInferiorState> createdInferiors;
        void selectInferiorOnce(long exec_thread_group);
#endif
        string buf;
        const char *debugged_program;
        bool running;
        map<long /* group-id */, string> remotes;
        map<long /* group-id */, long /* pid */> groups;
        /* All threads mapped to a group id*/
        map<long /* thread-id */, long /* group-id */> group_ids;
        /* All threads */
        map<long /* thread-id */, long /* pid */> threads;
        /* Threads where the exec() call was made */
        map<long /* thread-id */, long /* group_id */> exec_threads;

        map<long /* exec group */, long /* remote group */> remote_groups;
};
/*
 * auto-continue on fork stop needs work. the proxy sends -continue before AD7 requests thread info for the stopped thread
 * which means GBD will error on getting the thread info, and AD7 will exit the debugger.
 * -continue should be held until after AD7 is done querying the debugger
 */
// #define STOP_ON_FORK 1
static const string_view GDB_INITIALIZATION(
#ifdef STOP_ON_FORK
     "catch fork\n"
#endif
     "catch exec\n"
     "set detach-on-fork off\n"
     "set follow-fork-mode parent\n"
#ifdef DEBUG
     "set trace-commands on\n"
#endif
    );

void CmdFilter::InitializeDebugger()
{
    buf.append(GDB_INITIALIZATION);
    select_channel::InitializeDebugger();
}
static const string_view GDB_SELECT_FIRST_THREAD("inferior 1\n");
static const string_view GDB_SCHEDULE_MULTIPLE_ON("-gdb-set schedule-multiple on\n");
static const string_view GDB_SCHEDULE_MULTIPLE_OFF("-gdb-set schedule-multiple off\n");
static const filter_edit GDB_EXEC_CONTINUE
    { regex("-exec-continue\n"), };
static const filter_edit GDB_EXEC_STEPS
    { regex("-exec-(next|step|finish)\n"), };
static const filter_edit GDB_FILE_EXEC_AND_SYMBOLS
    { regex("(\\d+)-file-exec-and-symbols ([^\n]+)\n"), };
static const string_view GDB_DONE("^done\n");
static const string_view GDB_FILE_SH_EXEC_HEAD("-file-exec-and-symbols sh\nset args -c \"exec ");
static const string_view GDB_FILE_SH_EXEC_TAIL("\"\n");

void
CmdFilter::onMatch(const string_view& in, const filter_it& match) {
    if (&match.filter == &GDB_EXEC_CONTINUE) {
        if (!schedule_multiple) {
            schedule_multiple = true;
            buf.append(GDB_SCHEDULE_MULTIPLE_ON);
        }
        buf.append(GDB_SELECT_FIRST_THREAD);
        // return; // forget the original --exec-continue without --thread-group
    } else if (&match.filter == &GDB_EXEC_STEPS) {
        if (schedule_multiple) {
            schedule_multiple = false;
            buf.append(GDB_SCHEDULE_MULTIPLE_OFF);
        }
    } else if (&match.filter == &GDB_FILE_EXEC_AND_SYMBOLS) {
        auto m = get_matches(in, match);
        // replace the 'file' command with 'file sh ; set -args -c "exec ..."'
        buf
            .append(m[1]) // cmdid
            .append(GDB_FILE_SH_EXEC_HEAD)
            .append(m[2]) // shell script name
            .append(GDB_FILE_SH_EXEC_TAIL);
        return; // skip appending the original command.
    }
    buf.append(in, match.it->position(), match.it->length());
}
string_view CmdFilter::filter(string_view input_buf)
{
    vector<filter_it> re_its = {
        FILTER_INIT(input_buf, GDB_EXEC_CONTINUE),
        FILTER_INIT(input_buf, GDB_EXEC_STEPS),
        FILTER_INIT(input_buf, GDB_FILE_EXEC_AND_SYMBOLS),
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

static const auto reit_end = reit_t();

string_view select_channel::filter_re(string_view input_buf, vector<filter_it> &re_its, string &buf)
{
    size_t at = 0, used_to = 0;
    bool have_match = false, have_any_match = false;
    do {
        auto min_it = re_its.begin();
        size_t pos = SIZE_MAX;
        for (auto i  = re_its.begin(); i != re_its.end(); i++) {
            auto &it = (*i).it;
            if (it != reit_end) {
                auto p = it->position();
                if (p <= pos) {
                    min_it = i;
                    pos = p;
                }
            }
        }
        
        auto &match = (*min_it);
        if ((have_match = (match.it != reit_end))) {
            if (!paused && !have_any_match) buf.clear();
            auto len = match.it->length();
            buf.append(input_buf, used_to, pos - used_to);
            onMatch(input_buf, match);
            at = pos;
            if (at + len > used_to)
                used_to = at + len;
            match.it++;
            have_any_match = true;
        }
    } while (have_match);
    if (!paused && !have_any_match)
        return input_buf;
    buf.append(input_buf, used_to, input_buf.size() - used_to);

    return buf;
}

match_results<string_view::const_iterator>
select_channel::get_matches(const string_view& in, const filter_it& match)
{
    std::match_results<std::string_view::const_iterator> m;
    string mbuf(in);
    auto instart = in.cbegin() + match.it->position();
    auto inend = instart + match.it->length();
    auto found = regex_search(instart, inend, m, match.filter.re);
    return m;
}

void
select_channel::onMatch(const string_view& in, const filter_it& match)
{}

static bool
getDebuggerVariable(long pid, std::string& debugger) {
    std::ostringstream filepath;
    filepath << "/proc/" << pid << "/environ"; // Construct the path to the environ file of the specified process

    std::ifstream procfile(filepath.str()); // Open the environ file of the specified process

    if (!procfile.is_open()) {
#if defined(DEBUG)
        std::cerr << "Error: Could not open " << filepath.str() << std::endl;
#endif
        return false;
    }

    std::string line;
    while (std::getline(procfile, line, '\0')) { // Read each entry in the environ file
        if (line.find("DEBUGGER_URI=") == 0) { // Check if the line contains the DEBUGGER_URI variable
            debugger.assign(line.substr(13)); // Return the content of the DEBUGGER_URI variable, excluding the variable name
            return true;
        }
    }

    return false; // DEBUGGER_URI variable not found
}

/* Microsoft's OpenDebugAD7 exits if any thread '*stopped,reason="exited-normally"'
 * This filter changes all stops to reason="subprocess-fin" except after the first
 * thread group exits (thread-group-exited,id="i1")
 */
// static const string_view GDB_STOP_AVOID_QUIT("-gdb-set schedule-multiple on\n");
static const string_view GDB_THREAD_EXITED("*stopped,reason=\"subprocess-fin\"\n");
static const filter_edit GDB_FIRST_THREAD_EXIT
    { regex("=thread-group-exited,id=\"i1\"\n", reopts), };
static const filter_edit GDB_INFERIOR_EXIT
    { regex("\\*stopped,reason=\"exited-normally\"[^\n]*\n", reopts), };
static const filter_edit GDB_INFERIOR_EXEC
    { regex("\\*stopped,reason=\"exec\".*,new-exec=\"([^\"]*)\",[^\n]+,thread-id=\"(\\d+)\"[^\n]+\n", reopts), };
#ifdef STOP_ON_FORK
static const filter_edit GDB_INFERIOR_FORK
    { regex("\\*stopped,reason=\"fork\"[^\n]*,newpid=\"(\\d+)\"[^\n]+,thread-id=\"(\\d+)\"[^\n]+\n", reopts), };
#endif

static const filter_edit GDB_THREAD_GROUP_STARTED
    { regex("=thread-group-started,id=\"i(\\d+)\",pid=\"(\\d+)\"\n", reopts), };
static const filter_edit GDB_THREAD_GROUP_ADDED
    { regex("=thread-group-added,id=\"i(\\d+)\"\n", reopts), };
static const filter_edit GDB_THREAD_CREATED
    { regex("=thread-created,id=\"(\\d+)\",group-id=\"i(\\d+)\"\n", reopts), };
static const filter_edit GDB_ERROR
    { regex("\\^error,msg=\"([^\"]*)\"\n", reopts), };
static const filter_edit GDB_ASYNC_STATUS_THREAD_RUNNING
    //{ regex("9999902\\^running\n", reopts), };
    { regex("\\*running,thread-id=\"(\\d+)\"\n", reopts), };
static const filter_edit GDB_REMOTE_CONNECTED
    { regex("=remote-connected,id=\"(\\d+)\",group-id=\"i(\\d+)\"\n", reopts), };
static const filter_edit GDB_ASYNC_STATUS_LIBRARY_LOADED
     { regex("=library-loaded[^\n]+,thread-group=\"i(\\d+)\"[^\n]+\n", reopts), };
static const filter_edit GDB_VERSION
    { regex("~\"GNU gdb \\(GDB\\) (\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)[^\"]+\"\n", reopts), };

#define CMDBASE_MASK 0xFFF000
#ifdef STOP_ON_FORK
#define CMDBASE_CONTINUE_AFTER_FORK 0x996000
#endif
#define CMDBASE_CONTINUE_AFTER_EXEC 0x997000
#define CMDBASE_SELECT_INFERIOR 0x998000
static const filter_edit GDB_DONE_WITH_NUM_VALUE
    { regex("(\\d+)\\^done,value=\"(\\d+)\"\n", reopts), };

#define CMDBASE_ADD_INFERIOR 0x999000
static const filter_edit GDB_INFERIOR_ADDED
    { regex("(\\d+)\\^done,inferior=\"i(\\d+)\",connection=\\{number=\"(\\d+)\",name=\"native\"\\}\n", reopts), };
    // { regex("9999925\n", reopts), };

void
OutFilter::onMatch(const string_view& in, const filter_it& match) {
    if (&match.filter == &GDB_INFERIOR_EXIT) {
        if (running) {
            buf.append(GDB_THREAD_EXITED);
            return;
        }
    } else
    if (&match.filter == &GDB_INFERIOR_EXEC) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, pathname, thread id)");
        long thread = stol(m[2]);
        long group_id = group_ids[thread];
        auto pid = threads[thread];
        exec_threads[thread] = group_id;
        string remote_debugger;
        auto has_remote = getDebuggerVariable(pid, remote_debugger);
        buf.append("~\"Executing " + m[1].str() + " as pid " + to_string(pid) + 
        (has_remote ? 
            (remote_debugger.size() ? " to debug remotely via " + remote_debugger : " without debugging") :
            ""
        ) + "\\n\"\n");

        if (has_remote) {
            // buf_to_loopback.append("-target-detach\n");
//            if (GDB_8_2_CRASH_ON_THREAD_INFO_AFTER_DETACH)
//                buf_to_loopback.append("-thread-select 1\n");
            if (remote_debugger.size()) {
                remotes[group_id] = remote_debugger;
                buf_to_loopback.append(
#ifdef DEBUG
                    "shell echo i" + to_string(group_id) + " has remote " + remote_debugger + "\n"
#endif
                /* remote_debugger is not sanitized - can lead to arbitrary execution
                 * but does it need to be sanitized? The user already has arbitrary execution priviledge
                 */
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR
                        "9999901-gdb-set schedule-multiple on\n"
#endif
                );
#ifndef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
                auto created_it = createdInferiors.emplace(group_id, INFERIOR_STATE_INIT_NEW);
                assert(created_it.second && "createdInferior should not yet exist");
#endif
                paused = true;

            } else {
                /* Empty DEBUGGER_URI means detach this process */
                buf_to_loopback.append(
                    "detach inferior " + to_string(group_id) + "\n"
                );
            }
        }
        buf_to_loopback.append(

                    "inferior 1\n"
                    + to_string(CMDBASE_CONTINUE_AFTER_EXEC + group_id) +
                    "-exec-continue\n"
        );
        /* Remove stop notification; ad7 does not recognize stop on exec */
        // in.remove_prefix(match.it->length());
        return;
    }
    buf.append(in, match.it->position(), match.it->length());
    if (&match.filter == &GDB_FIRST_THREAD_EXIT) {
        if (running) {
            running = false;
        }
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
    if (&match.filter == &GDB_THREAD_GROUP_ADDED) {
        auto m = get_matches(in, match);
        assert(m.size() == 2 && "Exactly 2 things is captured (full string, thread group number)");
        long id = stol(m[1]);
        groups.emplace(id, 0);
    } else
    if (&match.filter == &GDB_THREAD_GROUP_STARTED) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, thread group number, pid)");
        long id = stol(m[1]);
        long pid = stol(m[2]);
        groups[id] = pid;
    } else
    if (&match.filter == &GDB_THREAD_CREATED) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, thread group number, thread_group)");
        long id = stol(m[1]);
        long group_id = stol(m[2]);
        auto pid = threads[id] = groups[group_id];
        group_ids[id] = group_id;
        buf.append("~\"Thread " + to_string(id) + " is pid " + to_string(pid) + "\\n\"\n");
    } else
    if (&match.filter == &GDB_REMOTE_CONNECTED) {
        if (paused)
            paused = false;
    } else
    if (&match.filter == &GDB_ERROR) {
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
        buf_to_loopback.append(
                    "inferior 1\n"
                    + to_string(CMDBASE_CONTINUE_AFTER_FORK) +
                    "-exec-continue\n"
        );
#endif
    } else
    if (&match.filter == &GDB_INFERIOR_ADDED) {
        auto m = get_matches(in, match);
        assert(m.size() == 4 && "Exactly 4 things is captured (full string, exec_thread_group, thread group, connection num)");
        long exec_thread_group = stol(m[1]) - CMDBASE_ADD_INFERIOR;
        long remote_thread_group = stol(m[2]);
        remote_groups[exec_thread_group] = remote_thread_group;
    } else
    if (&match.filter == &GDB_DONE_WITH_NUM_VALUE) {
        auto m = get_matches(in, match);
        assert(m.size() == 3 && "Exactly 3 things is captured (full string, command ID, value)");
        long cmdid = stol(m[1]);
        if ((cmdid & CMDBASE_MASK) == CMDBASE_SELECT_INFERIOR) {
            long exec_thread_group = cmdid - CMDBASE_SELECT_INFERIOR;
            auto remote = remotes.find(exec_thread_group);
            assert(remote != remotes.end() && "inferior selected should correspond to a remote");
            assert(remote->second.size() && "should only store non-empty remotes");
            buf_to_loopback.append(
                    "shell sleep 0.2\n"
                    "9999915-target-select extended-remote " + remote->second + "\n"
#ifdef SLOW_DOWN
                    "shell sleep 5\n"
#endif
            );
            remotes.erase(remote);
        } else
        if ((cmdid & CMDBASE_MASK) == CMDBASE_ADD_INFERIOR) {
            long exec_thread_group = cmdid - CMDBASE_ADD_INFERIOR;
#ifdef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
            auto remote_it = remote_groups.find(exec_thread_group);
            assert(remote_it != remote_groups.end() && "done is not related");
            auto remote = remotes.find(exec_thread_group);
            assert(remote != remotes.end() && "inferior selected should correspond to a remote");
            buf_to_loopback.append(
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR_PART_3
                "inferior i" + to_string(remote_it->second) + "\n"
                "" + to_string(exec_thread_group + CMDBASE_SELECT_INFERIOR) + "-gdb-show annotate\n"
#endif
                "shell echo timing barrier\n"
            );
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
    if (&match.filter == &GDB_ASYNC_STATUS_LIBRARY_LOADED) {
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
    if (&match.filter == &GDB_VERSION) {
        auto m = get_matches(in, match);
        assert(m.size() == 5 && "Exactly 5 things is captured (full string, major, minor, patch, build)");
        debuggerInfo.major = stol(m[1]);
        debuggerInfo.minor = stol(m[2]);
        debuggerInfo.patch = stol(m[3]);
        debuggerInfo.build = stol(m[4]);
        IdentifyDebugger();
    }
}

#ifndef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
void
OutFilter::selectInferiorOnce(long exec_thread_group)
{
    auto created_it = createdInferiors.find(exec_thread_group);
    if (created_it != createdInferiors.end()) {
        auto &state = created_it->second;
        if (!state.added) {
            buf_to_loopback.append(
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR_PART_2
#ifdef SLOW_DOWN
                    "shell sleep 5\n"
#endif
                    "shell sleep 0.2\n"
                    "" + to_string(exec_thread_group + CMDBASE_ADD_INFERIOR) + "-add-inferior\n"
                    "" + to_string(exec_thread_group + CMDBASE_ADD_INFERIOR) + "-gdb-show annotate\n"
#ifdef SLOW_DOWN
                    "shell sleep 5\n"
#endif
#endif
            );
            state.added = 1;
        } else
        if (!state.selected && state.libloaded && state.created) {

            auto remote_it = remote_groups.find(exec_thread_group);
            if (remote_it != remote_groups.end()) {
                assert(remote_it != remote_groups.end() && "done is not related");
                // auto remote = remotes.find(exec_thread_group);
        // assert(0 && "Debugging");
                // assert(remote != remotes.end() && "inferior selected should correspond to a remote");
                buf_to_loopback.append(
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR_PART_3
                    "inferior i" + to_string(remote_it->second) + "\n"
                    "" + to_string(exec_thread_group + CMDBASE_SELECT_INFERIOR) + "-gdb-show annotate\n"
#endif
                    // "-gdb-show verbose\n"
                    // "info infe\n"
                    "shell echo timing barrier\n"
                );
            } else {
                buf_to_loopback.append(
                    "shell echo lib loaded bug not for a remote group\n"
                );

            }
            state.selected = 1;
        }
    }
}
#endif

string_view OutFilter::filter(string_view input_buf)
{
    vector<filter_it> re_its = {
        FILTER_INIT(input_buf, GDB_FIRST_THREAD_EXIT),
        FILTER_INIT(input_buf, GDB_INFERIOR_EXIT),
        FILTER_INIT(input_buf, GDB_THREAD_GROUP_ADDED),
        FILTER_INIT(input_buf, GDB_THREAD_GROUP_STARTED),
        FILTER_INIT(input_buf, GDB_THREAD_CREATED),
        FILTER_INIT(input_buf, GDB_INFERIOR_EXEC),
#ifdef STOP_ON_FORK
        FILTER_INIT(input_buf, GDB_INFERIOR_FORK),
#endif
        FILTER_INIT(input_buf, GDB_DONE_WITH_NUM_VALUE),
        FILTER_INIT(input_buf, GDB_ERROR),
        FILTER_INIT(input_buf, GDB_INFERIOR_ADDED),
        FILTER_INIT(input_buf, GDB_ASYNC_STATUS_THREAD_RUNNING),
        FILTER_INIT(input_buf, GDB_ASYNC_STATUS_LIBRARY_LOADED),
        FILTER_INIT(input_buf, GDB_REMOTE_CONNECTED),
    };
    if (!identified) {
        re_its.emplace_back(
            FILTER_INIT(input_buf, GDB_VERSION)
        );
    }
    return filter_re(input_buf, re_its, buf);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <gdbprog> <args...>\n", argv[0]);
        return 1;
    }

    int child_in[2];
    if (pipe(child_in)) {
        perror("child in pipe");
        exit(2);
    }
    int child_out[2];
    if (pipe(child_out)) {
        perror("child out pipe");
        exit(2);
    }

    pid_t pid = fork();
    if (pid == -1) {
        perror("fork");
        return 1;
    } else if (pid == 0) { // Child process
        int r = dup2(child_out[WRITE_END], STDOUT_FILENO);
        close(child_out[READ_END]);
        close(child_out[WRITE_END]);
        if (r < 0) {
            perror("dup2 child out");
            return 1;
        }

        r = dup2(child_in[READ_END], STDIN_FILENO);
        close(child_in[WRITE_END]);
        close(child_in[READ_END]);
        if (r < 0) {
            perror("dup2 child in");
            return 1;
        }
        vector<char *> debugger_args;
        char shell[] = "sh";
        debugger_args.push_back(argv[2]);
        debugger_args.push_back(argv[1]);
        debugger_args.insert(debugger_args.end(), &argv[4], &argv[argc]);
        debugger_args.push_back(shell);
        debugger_args.push_back(NULL);
        execvp(argv[2], debugger_args.data());
        perror("execvp");
        return 1;
    } else { // Parent process
        close(child_in[READ_END]);
        close(child_out[WRITE_END]);
        fcntl(STDIN_FILENO, O_NONBLOCK);
        // fcntl(STDOUT_FILENO, O_NONBLOCK);
        // fcntl(child_in[WRITE_END], O_NONBLOCK);
        fcntl(child_out[READ_END], O_NONBLOCK);

        fd_set write_fdset;
        fd_set read_fdset;
        FD_ZERO(&write_fdset);
        FD_ZERO(&read_fdset);
        FD_SET(STDIN_FILENO, &read_fdset);
        FD_SET(child_out[READ_END], &read_fdset);
        int nfd = child_out[READ_END];

        int opened_channels = 0;
        struct OutFilter child_to_parent(
            argv[3],
            child_out[READ_END], STDOUT_FILENO,
            write_fdset, read_fdset,
            nfd);
        struct CmdFilter parent_to_child(
            STDIN_FILENO, child_in[WRITE_END],
            write_fdset, read_fdset,
            nfd);
        struct timeval wrapup_timeout = { .tv_sec = 1, .tv_usec = 0 };
        xfer_state
            parent_state = PASSTHROUGH,
            child_state = PASSTHROUGH;

        do {
            int res = select(nfd + 1, &read_fdset, &write_fdset, NULL,
                (parent_state != CLOSED) ? NULL : &wrapup_timeout);
            if (res < 0) {
                if (errno != EINTR)
                    break;
                /* will continue on signals*/
            } else if (!res) {
                /* Timeout - gdb 8.2 hangs with 100% cpu sometimes */
                kill(pid, SIGKILL);
                break;
            } else {
                    if (parent_state != CLOSED)
                        parent_state = parent_to_child.xfer();
                    if (child_state != CLOSED)
                        child_state = child_to_parent.xfer(parent_to_child);
                opened_channels = parent_state || child_state;
            }
        } while (opened_channels);
        int pid_stat = 0;
        waitpid(pid, &pid_stat, 0);
    }

    return 0;
}
