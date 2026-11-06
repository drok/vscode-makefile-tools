#include <cstdio>
#include <cstdlib>
//#include <unistd.h>
//#include <fcntl.h>
//#include <getopt.h>

// #include "config.h"
//#include <sys/wait.h>
// #include <signal.h>

// #include <string>
#include <string_view>
#include <regex>
// #include <map>


struct DebuggerInfo {
    /* Debugger version */
    long major, minor, patch, build;
};

struct filter_edit {
    /* Regular Expression to match */
    std::regex     re;
    #define   reopts (std::regex::optimize)
};

typedef std::regex_iterator<std::string_view::iterator> reit_t;
struct filter_it {
    /* Filter definition, including replacement string */
    const filter_edit     &filter;

    /* regex iterator for this filter */
    reit_t          it;
};
#define FILTER_INIT(b,f) filter_it{ f, std::regex_iterator<std::string_view::iterator>(b.begin(), b.end(), f.re), }

enum xfer_state {
    CLOSED = 0,
    PASSTHROUGH = 1,
    LOOPBACK = 2,
    INITIALIZE = 3,
};

class select_channel {
    public:
        select_channel(int ifd, int ofd,
            fd_set &write_fdset,
            fd_set &read_fdset,
            int &nfd,
            const char *id) :
            ifd(ifd),
            ofd(ofd),
            write_fdset(write_fdset),
            read_fdset(read_fdset),
            nfd(nfd),
            id(id),
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
        virtual std::string_view filter(std::string_view v);
        virtual std::string_view filter_re(std::string_view v, std::vector<filter_it> &re_its, std::string &buf);
        std::match_results<std::string_view::const_iterator> get_matches(const std::string_view& in, const filter_it& match);
        virtual void out(std::string_view& v);
        virtual void onMatch(const std::string_view& in, const filter_it& match);
        virtual void IdentifyDebugger();
        virtual void InitializeDebugger();

    private:
        std::string_view buf_to_send;
        char buf_to_parent[BUFSIZ];
        const char *id;

    protected:
        /* Data to return to the parent*/
        bool paused;
        bool initialized;
        bool identified;
        DebuggerInfo debuggerInfo;
        std::string_view view_to_loopback;
        void sendTo(std::string_view v, std::string &console);
        void sendToConsole(std::string_view v, std::string &console);

    private:
        std::string buf_to_loopback;
        bool closing;
};

bool getDebuggerVariable(long pid, std::string& debugger);
class OutFilterAd7 : public select_channel {
    public:
        OutFilterAd7(
            const char *debugged_program,
            int ifd, int ofd,
            fd_set &write_fdset,
            fd_set &read_fdset,
            int &nfd,
            std::string &buf,
            const char *id) :
            buf(buf),
            select_channel(ifd, ofd, write_fdset, read_fdset, nfd, id),
            debugged_program(debugged_program),
            running(true) {}
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
#endif
        std::string& buf;
        const char *debugged_program;
        bool running;
        std::map<long /* group-id */, std::string> remotes;
        std::map<long /* group-id */, long /* pid */> groups;
        /* All threads mapped to a group id*/
        std::map<long /* thread-id */, long /* group-id */> group_ids;
        /* All threads */
        std::map<long /* thread-id */, long /* pid */> threads;
        /* Threads where the exec() call was made */
        std::map<long /* thread-id */, long /* group_id */> exec_threads;

        std::map<long /* exec group */, long /* remote group */> remote_groups;
};

class CmdFilterAd7 : public select_channel {
    public:
        CmdFilterAd7(int ifd, int ofd,
            fd_set &write_fdset,
            fd_set &read_fdset,
            int &nfd,
            std::string &console,
            const char *id) :
            console(console),
            select_channel(ifd, ofd, write_fdset, read_fdset, nfd, id),
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
