/*
 * C++ Class that uses the liburiparser-dev library to parse a URI. The class name is "Debuggers"
 *
 * The query arguments:
 *    bin - adds the value to the member variable which is a set of strings named "bin"
 *    binargs - each value is space separated list. The list is added to member set as a vector of strings named "binargs"
 *
 * Methods:
 *    isBin(string name) - returns true if the name exists in the "bin" set
 *    isInvocation(char **argv) - returns true if any of the binargs values matches the argv array
 *
 * Constructor takes a URI and parses it
 */

#include "Debuggers.h"

#include <uriparser/Uri.h>
using namespace std;

/* vim: set noexpandtab tabstop=2: */


Debuggers::Debuggers(string uri) {
    /* populate the bin and binargs set from the query of the uri after parsing it */
    UriParserStateA state;
    UriUriA uri_struct;
    state.uri = &uri_struct;
    if (uriParseUriA(&state, uri.c_str()) == URI_SUCCESS) {
        UriQueryListStructA *query_list;
        int item_count;
        if (uriDissectQueryMallocA(&query_list, &item_count, uri_struct.query.first, uri_struct.query.afterLast) == URI_SUCCESS) {
            UriQueryListStructA *current = query_list;
            while (current) {
                if (strcmp(current->key, "bin") == 0) {
                    bin.insert(current->value);
                } else if (strcmp(current->key, "binargs") == 0) {
                    // Split the string on space using strpbrk and add to binargs set
                    const char *start = current->value;
                    vector<string> args;
                    while (*start) {
                        //skip any leading spaces
                        while (*start == ' ') start++;

                        if (!*start) break;

                        // Find the end of the current word
                        const char *end = start;
                        while (*end && *end != ' ') end++;

                        // Extract the word
                        args.emplace_back(start, end - start);
                    }
                    if (args.size())
                        // move the args vector into the binargs vector of vectors
                        binargs.push_back(move(args));
                }
                current = current->next;
            }
            uriFreeQueryListA(query_list);
        }
    }
    uriFreeUriMembersA(&uri_struct);
}

bool Debuggers::isBin(string name) const
{
    return bin.find(name) != bin.end();
}

bool Debuggers::isInvocation(char **argv, int argc) const
{
    for (const auto& binarg : binargs) {
        /* Check that all argv strings are found in the binarg set */
        if (argc < static_cast<int>(binarg.size())) {
            continue;
        }

        /* Compare the argv array with each binargs entry */
        bool match = true;
        int i = 0;

        for (const auto& arg : binarg) {
            if (arg != argv[i++]) {
                match = false;
                break;
            }
        }

        /* If we've reached the end of argv and all elements matched, it's a match */
        if (match) return true;
    }
    return false;
}
