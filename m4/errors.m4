
m4_define([_AT_ERROR_PREPARE],
[AS_REQUIRE_SHELL_FN([at_fn_error],,
[as_status=$[1]; test $as_status -eq 0 && as_status=1
m4_ifval(AS_MESSAGE_LOG_FD,
[m4_pushdef([AS_MESSAGE_LOG_FD], [$[4]])dnl
  if test "$[4]"; then
    AS_LINENO_PUSH([$[3]])
    _AS_ECHO_LOG([error: $[2]])
  fi
m4_define([AS_MESSAGE_LOG_FD])], [m4_pushdef([AS_MESSAGE_LOG_FD])])dnl
  _AT_ECHO([error: $[2]], [$[5]])
_m4_popdef([AS_MESSAGE_LOG_FD])dnl
  AS_EXIT([$as_status])])])

m4_defun_init([AS_ERROR],
[m4_append_uniq([_AS_CLEANUP],
  [m4_divert_text([M4SH-INIT-FN], [_AT_ERROR_PREPARE[]])])],
[at_fn_error m4_default([$2], [$?]) "_AS_QUOTE([$1])"m4_ifval(AS_MESSAGE_LOG_FD,
  [ "$LINENO" AS_MESSAGE_LOG_FD])])

m4_defun([_AT_ECHO],
[_AS_ECHO([$2: $1])])

AC_DEFUN([AC_MSG_ERROR],[at_fn_error m4_default([$2], [$?]) "_AS_QUOTE([$1])"m4_ifval(AS_MESSAGE_LOG_FD,
  [ "$LINENO" AS_MESSAGE_LOG_FD]) m4_location])

AC_DEFUN([AC_MSG_WARN],
[_AT_ECHO([WARNING: $1], m4_location)])# AS_WARN

AC_DEFUN([AC_MSG_NOTICE],
[_AT_ECHO([notice: $1], m4_location)])# AS_NOTICE

m4_define([ZZZZZ],
[echo This is my M4 macroz])

AC_DEFUN([ZZZZZ],
[echo This is my AC macroz])
