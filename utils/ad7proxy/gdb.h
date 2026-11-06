#include <string>
#include <string_view>
#include "filters.h"

#define GDB_CMDBASE_MASK 0xFFF000
#define GDB_CMDBASE_CONTINUE_AFTER_THREAD_CREATED 0x995000
#ifdef STOP_ON_FORK
#define CMDBASE_CONTINUE_AFTER_FORK 0x996000
#endif
#define GDB_CMDBASE_CONTINUE_AFTER_EXEC 0x997000
#define GDB_CMDBASE_SELECT_INFERIOR 0x998000
#define GDB_CMDBASE_ADD_INFERIOR 0x999000

struct GDB {
    
    // Instance members
    static const filter_edit FIRST_THREAD_EXIT;
    static const std::string_view THREAD_EXITED;

    // Static const members moved inside
    static const filter_edit INFERIOR_EXIT;
    static const filter_edit INFERIOR_EXIT_W_ERROR;
    static const filter_edit INFERIOR_EXEC;
#ifdef STOP_ON_FORK
    static const filter_edit INFERIOR_FORK;
#endif
    static const filter_edit THREAD_GROUP_STARTED;
    static const filter_edit THREAD_GROUP_EXITED;
    static const filter_edit THREAD_GROUP_ADDED;
    static const filter_edit THREAD_GROUP_REMOVED;
    static const filter_edit THREAD_CREATED;
    static const filter_edit ERROR;
    static const filter_edit ASYNC_STATUS_THREAD_RUNNING;
    static const filter_edit REMOTE_CONNECTED;
    static const filter_edit ASYNC_STATUS_LIBRARY_LOADED;
    static const filter_edit VERSION_STR;
    static const filter_edit DONE_WITH_NUM_VALUE;
    static const filter_edit INFERIOR_ADDED;
    static const filter_edit EXEC_CONTINUE_RE;
    static const filter_edit EXEC_STEPS;
    static const filter_edit FILE_EXEC_AND_SYMBOLS;

    /* Commands */
    static const std::string_view INITIALIZATION;
    static const std::string_view SCHEDULE_MULTIPLE_ON;
    static const std::string_view SCHEDULE_MULTIPLE_OFF;
    static const std::string_view EXEC_CONTINUE;
    static const std::string_view BREAKPOINTS_ENABLE;
    static const std::string_view BREAKPOINTS_DISABLE;

};
