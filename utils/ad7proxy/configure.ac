AC_INIT([ad7proxy], [1.0.0])

AM_INIT_AUTOMAKE([-Wall -Werror foreign])

AC_CONFIG_MACRO_DIR([m4])

AC_LANG([C++])

# Save original CXXFLAGS and remove -Werror for the feature test
# because it breaks AX_CXX_COMPILE_STDCXX detection
std_check_saved_CXXFLAGS="$CXXFLAGS"
CXXFLAGS=$(echo "$CXXFLAGS" | sed 's/-Werror//g')
AX_CXX_COMPILE_STDCXX([20], [noext], [mandatory])
# Restore the original CXXFLAGS (including -Werror)
CXXFLAGS="$std_check_saved_CXXFLAGS"

AC_PROG_CXX

AC_ARG_ENABLE(debug,
AS_HELP_STRING([--enable-debug],
               [enable debugging, default: no]),
[case "${enableval}" in
             yes) debug=true ;;
             no)  debug=false ;;
             *)   AC_MSG_ERROR([bad value ${enableval} for --enable-debug]) ;;
esac],
[debug=false])
AM_CONDITIONAL(DEBUG, test x"$debug" = x"true")

PKG_CHECK_MODULES([URIPARSER], [liburiparser],,[have_liburiparser=no])

AC_CONFIG_HEADERS([config.h])
AC_CONFIG_FILES([
 Makefile
])
AC_OUTPUT
