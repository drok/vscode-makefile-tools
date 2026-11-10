#include "filters.h"

class CmdFilterVgdb : public select_channel {
    public:
        CmdFilterVgdb(int ifd, int ofd,
            fd_set &write_fdset,
            fd_set &read_fdset,
            int &nfd,
            std::string &console,
            const char *id) :
            select_channel(ifd, ofd, write_fdset, read_fdset, nfd, id),
            console(console),
            schedule_multiple(false) {

            }
        virtual std::string_view filter(std::string_view v) override;
        void InitializeDebugger() override;
    private:
        void onMatch(const std::string_view& in, const filter_it& match) override;

        std::string buf;
        std::string &console;
        bool schedule_multiple;
};

class OutFilterVgdb : public select_channel {
    public:
        OutFilterVgdb(
            const char *debugged_program,
            int ifd, int ofd,
            fd_set &write_fdset,
            fd_set &read_fdset,
            int &nfd,
            std::string &buf,
            const char *id) :
            select_channel(ifd, ofd, write_fdset, read_fdset, nfd, id),
            buf(buf),
            //debugged_program(debugged_program),
            breakpoints_enabled(true),
            last_thread_group_exit(0),
            running(true)
            {}
        virtual std::string_view filter(std::string_view v) override;
    private:
        void onMatch(const std::string_view& in, const filter_it& match) override;
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
        std::map<long /* group-id */, CreatedInferiorState> createdInferiors;
        void selectInferiorOnce(long exec_thread_group);
        void enableBreakpoints();
        void disableBreakpoints();

#endif
        std::string& buf;
        // const char *debugged_program;
        bool breakpoints_enabled;
        long last_thread_group_exit;
        bool running;
        std::map<long /* group-id */, std::string> remotes;
        std::map<long /* group-id */, long /* pid */> groups;
        ///* All threads mapped to a group id*/
        std::map<long /* thread-id */, long /* group-id */> group_ids;
        ///* All threads */
        std::map<long /* thread-id */, long /* pid */> threads;
        ///* Threads where the exec() call was made */
        std::map<long /* thread-id */, long /* group_id */> exec_threads;
//
        std::map<long /* exec group */, long /* remote group */> remote_groups;
};

