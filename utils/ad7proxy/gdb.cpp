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

using namespace std;

inline const string_view GDB::THREAD_EXITED("*stopped,reason=\"subprocess-fin\",stopped-threads=\"all\"\n");

inline const filter_edit GDB::FIRST_THREAD_EXIT
    { regex("=thread-group-exited,id=\"i1\"\n", reopts), };
inline const filter_edit GDB::INFERIOR_EXIT
    { regex("\\*stopped,reason=\"exited-normally\"[^\n]*\n", reopts), };
inline const filter_edit GDB::INFERIOR_EXIT_W_ERROR
    { regex("\\*stopped,reason=\"exited\",exit-code=\"(\\d+)\"*\n", reopts), };
inline const filter_edit GDB::INFERIOR_EXEC
    { regex("\\*stopped,reason=\"exec\".*,new-exec=\"([^\"]*)\",[^\n]+,thread-id=\"(\\d+)\"[^\n]+\n", reopts), };
#ifdef STOP_ON_FORK
inline const filter_edit GDB::INFERIOR_FORK
    { regex("\\*stopped,reason=\"fork\"[^\n]*,newpid=\"(\\d+)\"[^\n]+,thread-id=\"(\\d+)\"[^\n]+\n", reopts), };
#endif

inline const filter_edit GDB::THREAD_GROUP_STARTED
    { regex("=thread-group-started,id=\"i(\\d+)\",pid=\"(\\d+)\"\n", reopts), };
inline const filter_edit GDB::THREAD_GROUP_EXITED
    { regex("=thread-group-exited,id=\"i(\\d+)\",exit-code=\"(\\d+)\"\n", reopts), };
inline const filter_edit GDB::THREAD_GROUP_ADDED
    { regex("=thread-group-added,id=\"i(\\d+)\"\n", reopts), };
inline const filter_edit GDB::THREAD_GROUP_REMOVED
    { regex("=thread-group-removed,id=\"i(\\d+)\"\n", reopts), };
inline const filter_edit GDB::THREAD_CREATED
    { regex("=thread-created,id=\"(\\d+)\",group-id=\"i(\\d+)\"\n", reopts), };
inline const filter_edit GDB::ERROR
    { regex("\\^error,msg=\"([^\"]*)\"\n", reopts), };
inline const filter_edit GDB::ASYNC_STATUS_THREAD_RUNNING
    //{ regex("9999902\\^running\n", reopts), };
    { regex("\\*running,thread-id=\"(\\d+)\"\n", reopts), };
inline const filter_edit GDB::REMOTE_CONNECTED
    { regex("=remote-connected,id=\"(\\d+)\",group-id=\"i(\\d+)\"\n", reopts), };
inline const filter_edit GDB::ASYNC_STATUS_LIBRARY_LOADED
     { regex("=library-loaded[^\n]+,thread-group=\"i(\\d+)\"[^\n]+\n", reopts), };
inline const filter_edit GDB::VERSION_STR
    { regex("~\"GNU gdb \\(GDB\\) (\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)[^\"]+\"\n", reopts), };

inline const filter_edit GDB::DONE_WITH_NUM_VALUE
    { regex("(\\d+)\\^done,value=\"(\\d+)\"\n", reopts), };

inline const filter_edit GDB::INFERIOR_ADDED
    { regex("(\\d+)\\^done,inferior=\"i(\\d+)\",connection=\\{number=\"(\\d+)\",name=\"native\"\\}\n", reopts), };
    // { regex("9999925\n", reopts), };

inline const filter_edit GDB::EXEC_CONTINUE_RE
    { regex("-exec-continue\n"), };
inline const filter_edit GDB::EXEC_STEPS
    { regex("-exec-(next|step|finish)\n"), };
inline const filter_edit GDB::FILE_EXEC_AND_SYMBOLS
    { regex("(\\d+)-file-exec-and-symbols ([^\n]+)\n"), };

inline const string_view GDB::INITIALIZATION(
#ifdef STOP_ON_FORK
     "set non-stop off\n"
     "catch fork\n"
#endif
     "catch exec\n"
     "set detach-on-fork off\n"
     "set follow-fork-mode parent\n"
#ifdef DEBUG
     "set trace-commands on\n"
#endif
    );

inline const string_view GDB::SCHEDULE_MULTIPLE_ON("-gdb-set schedule-multiple on\n");
inline const string_view GDB::SCHEDULE_MULTIPLE_OFF("-gdb-set schedule-multiple off\n");
inline const string_view GDB::EXEC_CONTINUE("-exec-continue\n");
inline const string_view GDB::BREAKPOINTS_DISABLE("-break-disable\n");
inline const string_view GDB::BREAKPOINTS_ENABLE("-break-enable\n");
