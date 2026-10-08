bin_PROGRAMS = ad7proxy

EXTRA_FILES = debug.sh

ad7proxy_SOURCES = \
    Debuggers.cpp \
    ad7proxy.cpp
ad7proxy_CPPFLAGS =
ad7proxy_CXXFLAGS = \
    @URIPARSER_CFLAGS@
ad7proxy_LDADD = \
    @URIPARSER_LIBS@

noinst_HEADERS = \
    Debuggers.h

if DEBUG
    ad7proxy_CPPFLAGS += -DDEBUG
    ad7proxy_CXXFLAGS += -ggdb3 -O0
endif

TESTS = \
    t4-gdb-handle-exec-stop.sh \
    t3-gdb-rewrite-output.sh \
    t2-gdb-rewrites.sh \
    t1-simple.sh
