#include <string>
#include <set>
#include <vector>

class Debuggers {
    private:
        std::set<std::string> bin;
        std::vector<std::vector<std::string> > binargs;

    public:
        Debuggers(std::string uri);
        bool isBin(std::string name) const;
        bool isInvocation(char **argv, int argc) const;
};

