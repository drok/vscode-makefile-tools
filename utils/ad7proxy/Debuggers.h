#include <string>
#include <set>
#include <vector>

class Debuggers {
    private:
        std::set<std::string> bin;
        std::set<std::vector<std::string>> binargs;

    public:
        Debuggers(std::string uri);
        bool isBin(std::string name);
        bool isInvocation(char **argv);
};

