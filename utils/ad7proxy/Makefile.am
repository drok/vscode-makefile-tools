bin_PROGRAMS = ad7proxy

ad7proxy_SOURCES = ad7proxy.cpp
ad7proxy_CPPFLAGS =
ad7proxy_CXXFLAGS =
ad7proxy_LDADD =

if DEBUG
    ad7proxy_CPPFLAGS += -DDEBUG
    ad7proxy_CXXFLAGS += -ggdb3 -O0
endif

TESTS = \
    t4-gdb-handle-exec-stop.sh \
    t3-gdb-rewrite-output.sh \
    t2-gdb-rewrites.sh \
    t1-simple.sh
