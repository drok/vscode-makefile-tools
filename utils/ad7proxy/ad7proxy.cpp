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
#include "gdb.h"
#include "ad7.h"
#include "vgdb.h"

/* TODO : Detect GDB version and only do this when needed
 * harmless to do it unnecessarily
 */
#define GDB_8_2_CRASH_ON_THREAD_INFO_AFTER_DETACH true

using namespace std;

#define WRITE_END 1
#define READ_END 0

/* Microsoft's OpenDebugAD7 exits if any thread '*stopped,reason="exited-normally"'
 * This filter changes all stops to reason="subprocess-fin" except after the first
 * thread group exits (thread-group-exited,id="i1")
 */
// static const string_view GDB_STOP_AVOID_QUIT("-gdb-set schedule-multiple on\n");

// void
// OutFilter::onMatch(const string_view& in, const filter_it& match) {
//     /* break up the in string into lines and pass them to onMatchLine one at a time */
//     size_t start = 0, end;
//     while ((end = in.find('\n', start)) != string_view::npos) {
//         string_view line(in);
//         line.remove_prefix(start);
//         line.remove_suffix(in.size() - end);
//         onMatch(line, match);
//         start = end + 1;
//     }
// }


#ifndef WAIT_FOR_LIBRARY_LOADING_DOESNT_NEED_WORKAROUND
void
OutFilterVgdb::selectInferiorOnce(long exec_thread_group)
{
    auto created_it = createdInferiors.find(exec_thread_group);
    if (created_it != createdInferiors.end()) {
        auto &state = created_it->second;
        if (!state.added) {
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR_PART_2
#ifdef SLOW_DOWN
            sendToLoopback("shell sleep 5", buf);
#endif
            sendTo("shell sleep 0.2", buf);
            sendTo("" + to_string(exec_thread_group + GDB_CMDBASE_ADD_INFERIOR) + "-add-inferior", buf);
            sendTo("" + to_string(exec_thread_group + GDB_CMDBASE_ADD_INFERIOR) + "-gdb-show annotate", buf);
#ifdef SLOW_DOWN
            sendToLoopback("shell sleep 5", buf);
#endif
#endif
            state.added = 1;
        } else
        if (!state.selected && state.libloaded && state.created) {

            auto remote_it = remote_groups.find(exec_thread_group);
            if (remote_it != remote_groups.end()) {
                assert(remote_it != remote_groups.end() && "done is not related");
                // auto remote = remotes.find(exec_thread_group);
        // assert(0 && "Debugging");
                // assert(remote != remotes.end() && "inferior selected should correspond to a remote");
#ifndef INCANTATION_NOT_NEEDED_TO_START_INFERIOR_PART_3
                sendTo("inferior " + to_string(remote_it->second), buf);
                sendTo("" + to_string(exec_thread_group + GDB_CMDBASE_SELECT_INFERIOR) + "-gdb-show annotate", buf);
#endif
                    // "-gdb-show verbose\n"
                    // "info infe\n"
                sendTo("shell echo timing barrier", buf);
            } else {
                sendTo("shell echo lib loaded bug not for a remote group", buf);
            }
            state.selected = 1;
        }
    }
}
#endif

static void print_usage(const char *progname) {
    fprintf(stderr, "Usage: %s <gdbprog> <args...>\n"
        "\t--help\n"
        "\t--mode-ad7\n"
        "\t--mode-vgdb\n"
        "\t--interpreter=mi\n"
        "\t--debugger=<gdb program>\n"
        "\t--debugee=<debugged program>\n"
        "\t--tty=<tty for debugee's output>\n"
        "\t--args=<debugee's args, NOT passed to debugger>\n"
        "\t-q (quiet)\n"

    , progname);
};


static void ignore_sigpipe() {
    struct sigaction sa = {};
    sa.sa_handler = SIG_IGN; // Ignore SIGPIPE
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;

    if (sigaction(SIGPIPE, &sa, nullptr) == -1) {
        std::cerr << "Failed to set SIGPIPE handler: " << std::strerror(errno) << '\n';
    }
}

bool debugger_exited = false;
static void handle_sigchld(int sig) {
    int saved_errno = errno; // Preserve errno

    // Loop with WNOHANG to reap ALL terminated children non-blockingly
    // -1 means wait for any child process
    pid_t pid;
    int status;

    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        if (WIFEXITED(status)) {
            // int exit_code = WEXITSTATUS(status);
            debugger_exited = true;
            // Safe to log simple things, but keep it minimal inside handlers
        } else if (WIFSIGNALED(status)) {
            // int term_sig = WTERMSIG(status);
            debugger_exited = true;
            // Child was killed by a signal
        }
    }

    errno = saved_errno;
}

template <typename CmdFilter, typename OutFilter>
static int proxy_loop(CmdFilter &parent_to_child, OutFilter &child_to_parent)
{
    int opened_channels = 0;
    struct timeval wrapup_timeout = { .tv_sec = 1, .tv_usec = 0 };
    xfer_state
        parent_state = PASSTHROUGH,
        child_state = PASSTHROUGH;
    int res;

    ignore_sigpipe();

    do {
        res = select(parent_to_child.nfd + 1, &parent_to_child.read_fdset, &parent_to_child.write_fdset, NULL,
            (parent_state != CLOSED) ? NULL : &wrapup_timeout);
        if (res < 0) {
            if (errno != EINTR)
                break;
            else
                if (debugger_exited)
                    break;
            /* will continue on signals*/
        } else if (!res) {
            break;
        } else {
                if (parent_state != CLOSED)
                    parent_state = parent_to_child.xfer();
                if (child_state != CLOSED) {
                    child_state = child_to_parent.xfer(parent_to_child);
                    if (child_state == CLOSED && parent_state != CLOSED)
                        parent_state = parent_to_child.end();
                }
            opened_channels = parent_state || child_state;
        }
    } while (opened_channels);
    return res;
}

static void setup_sigchld_handler() {
    struct sigaction sa;
    std::memset(&sa, 0, sizeof(sa));
    sa.sa_handler = handle_sigchld;
    sigemptyset(&sa.sa_mask);

    // SA_RESTART ensures that interrupted system calls (like read/write on pipes)
    // automatically restart instead of failing with EINTR.
    sa.sa_flags = SA_RESTART;

    if (sigaction(SIGCHLD, &sa, nullptr) == -1) {
        std::cerr << "Failed to set SIGCHLD handler\n";
    }
}
int main(int argc, char **argv) {

    struct ProxyOptions {
        enum ProxyMode : int {
                PROXY_MODE_AD7 = 1,
                PROXY_MODE_VGDB,
        };
        int mode;
        bool quiet;
        char *debugger;
        char *debugee;
        char *tty;
        char *args;
    } opt = {};

    struct option const long_options[] = {
        {"help",      no_argument,      NULL, 'h'},
        {"mode-ad7",  no_argument,      &opt.mode, ProxyOptions::PROXY_MODE_AD7},
        {"mode-vgdb", no_argument,      &opt.mode, ProxyOptions::PROXY_MODE_VGDB},
        {"debugger",  required_argument,NULL, 'd'},
        {"interpreter", required_argument, NULL, 'i'},
        {"debugee",   required_argument,NULL, 'e'},
        {"tty",       required_argument,NULL, 't'},
        {"args",      required_argument,NULL, 'a'},
        {"quiet",     no_argument,      NULL, 'q'},
        {nullptr,   0,                 nullptr,  0 } // Terminator
    };

    int optc = 0;

    std::string file_path = "";

    // Parse options: "hf:v" means 'h' and 'v' take no args, 'f' requires an arg (noted by ':')
    while ((optc = getopt_long(argc, argv, "hq", long_options, NULL)) != -1) {
        switch (optc) {
            case 0:
                break;

            case 'd':
                opt.debugger = optarg;
                break;

            case 'i':
                /* Ignore --interpreter=mi, I will hard code it below */
                break;

            case 'e':
                opt.debugee = optarg;
                break;

            case 'q':
                opt.quiet = true;
                break;

            case 't':
                opt.tty = optarg;
                break;

            case 'a':
                opt.args = optarg;
                break;

            case 'h':
            case ':':
            default:
                print_usage(argv[0]);
                return 1;
            case '?':
                fprintf(stderr, "ERR: Unknown argument\n");
                print_usage(argv[0]);
                return 2;
        }
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
        string debugee_1("sh");
        string debugee_2("-c");
        string debugee("exec \"");
        debugee += opt.debugee;
        debugee += "\"";
        string tty("--tty=");
        tty += opt.tty;
        string sep("--args");
        string interpreter("--interpreter=mi");
        string quiet("-q");

        debugger_args.push_back(opt.debugger);
        debugger_args.push_back(interpreter.data());
        if (opt.tty)
            debugger_args.push_back(tty.data());
        if (opt.quiet)
            debugger_args.push_back(quiet.data());

        debugger_args.push_back(sep.data());
        debugger_args.push_back(debugee_1.data());
        debugger_args.push_back(debugee_2.data());
        debugger_args.push_back(debugee.data());
        debugger_args.push_back(NULL);
        execvp(opt.debugger, debugger_args.data());
        perror("execvp");
        perror(opt.debugger);
        fprintf(stderr, "execvp('%s') failed: %s\n", opt.debugger, strerror(errno));
        return 1;
    } else { // Parent process
        close(child_in[READ_END]);
        close(child_out[WRITE_END]);
        fcntl(STDIN_FILENO, O_NONBLOCK);
        // fcntl(STDOUT_FILENO, O_NONBLOCK);
        // fcntl(child_in[WRITE_END], O_NONBLOCK);
        fcntl(child_out[READ_END], O_NONBLOCK);

        setup_sigchld_handler();

        fd_set write_fdset;
        fd_set read_fdset;
        FD_ZERO(&write_fdset);
        FD_ZERO(&read_fdset);
        FD_SET(STDIN_FILENO, &read_fdset);
        FD_SET(child_out[READ_END], &read_fdset);
        int nfd = child_out[READ_END];
        string buf_to_parent; /* debugger to IDE */

        switch (opt.mode) {
            case ProxyOptions::PROXY_MODE_AD7:
            {
                struct OutFilterAd7 child_to_parent(
                    argv[3],
                    child_out[READ_END], STDOUT_FILENO,
                    write_fdset, read_fdset,
                    nfd, buf_to_parent, ">");
                struct CmdFilterAd7 parent_to_child(
                    STDIN_FILENO, child_in[WRITE_END],
                    write_fdset, read_fdset,
                    nfd, buf_to_parent, "<");
                if (!proxy_loop(parent_to_child, child_to_parent)) {
                    /* Timeout - gdb 8.2 hangs with 100% cpu sometimes */
                    kill(pid, SIGKILL);
                }
            }
            break;
            case ProxyOptions::PROXY_MODE_VGDB:
            {
                struct OutFilterVgdb child_to_parent(
                    argv[3],
                    child_out[READ_END], STDOUT_FILENO,
                    write_fdset, read_fdset,
                    nfd, buf_to_parent, ">");
                struct CmdFilterVgdb parent_to_child(
                    STDIN_FILENO, child_in[WRITE_END],
                    write_fdset, read_fdset,
                    nfd, buf_to_parent, "<");
                if (!proxy_loop(parent_to_child, child_to_parent)) {
                    /* Timeout - gdb 8.2 hangs with 100% cpu sometimes */
                    kill(pid, SIGKILL);
                }
            }
            break;
        }
        if (!debugger_exited) {
            int pid_stat = 0;
            waitpid(pid, &pid_stat, 0);
        }
    }

    return 0;
}
