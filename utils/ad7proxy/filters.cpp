#include <cstdio>
#include <cstdlib>
#include <unistd.h>
#include <fcntl.h>
#include <getopt.h>
#include <utility>

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
#include "filters.h"

/* TODO : Detect GDB version and only do this when needed
 * harmless to do it unnecessarily
 */
#define GDB_8_2_CRASH_ON_THREAD_INFO_AFTER_DETACH true

using namespace std;

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


void
select_channel::sendToConsole(string_view v, string &console)
{
    return;
    console.append("~\" --- ");
    console.append(id);
    console.append(" --- ");
    // console.append(v);
    console.append("\\n\"\n");
}

void
select_channel::sendTo(string_view v, string &console)
{
    sendToConsole(v, console);
    buf_to_loopback.append(v);
    buf_to_loopback.append("\n");
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
        case PASSTHROUGH:
        case INITIALIZE:
        case CLOSED:
            break;
    }
    return res;
}

xfer_state
select_channel::xfer()
{
    ssize_t buf_to_parent_len;
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
            if(!paused && buf_to_send.size()) {
                ssize_t r = write(ofd, buf_to_send.data(), buf_to_send.size());
                if (r < 0) {
                    close(ifd);
    //                FD_CLR(ifd, &read_fdset);
                    closing = true;
                } else {
                    if (cmp_not_equal(r, buf_to_send.size())) {
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
            if (cmp_equal(r, buf_to_send.size())) {
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
            if (cmp_not_equal(sentlen, v.size())) {
            }
            v.remove_prefix(sentlen);
        }
    }
}

string_view
select_channel::filter(string_view v) {
    return v;
}

match_results<string_view::const_iterator>
select_channel::get_matches(const string_view& in, const filter_it& match)
{
    std::match_results<std::string_view::const_iterator> m;
    string mbuf(in);
    auto instart = in.cbegin() + match.it->position();
    auto inend = instart + match.it->length();
    regex_search(instart, inend, m, match.filter.re);
    return m;
}

void
select_channel::onMatch(const string_view& in, const filter_it& match)
{}


string_view select_channel::filter_re(string_view input_buf, vector<filter_it> &re_its, string &buf)
{
    static const auto reit_end = reit_t();
    size_t at = 0, used_to = 0;
    bool have_match = false, have_any_match = false;
    do {
        auto min_it = re_its.begin();
        size_t pos = SIZE_MAX;
        for (auto i  = re_its.begin(); i != re_its.end(); i++) {
            auto &it = (*i).it;
            if (it != reit_end) {
                auto p = it->position();
                if (cmp_less_equal(p, pos)) {
                    min_it = i;
                    pos = p;
                }
            }
        }

        auto &match = (*min_it);
        if (min_it != re_its.end() && (have_match = (match.it != reit_end))) {
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

bool
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
