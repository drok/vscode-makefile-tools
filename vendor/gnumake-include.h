/* Ensure memcpy is linked to this as opposed to memcpy@GLIBC_2.14, which
 * is the same, but reverts a buggy version in GLIBC_2.13. This force allows
 * the built binary to run on very old GLIBC versions. Without it, it would
 * require a newer GLIBC to run
 */

#include <sys/stat.h>

__asm__(".symver memcpy,memcpy@GLIBC_2.2.5");
__asm__(".symver clock_gettime,clock_gettime@GLIBC_2.2.5");

__asm__(".symver lstat,lstat@GLIBC_2.2.5");
#undef lstat
#define lstat(f,b) __lxstat(1,f,b)

__asm__(".symver __fxstat,__fxstat@GLIBC_2.2.5");
#undef fstat
#define fstat(f,b) __fxstat(1,f,b)

__asm__(".symver __xstat,__xstat@GLIBC_2.2.5");
#undef stat
#define stat(f,b) __xstat(1,f,b)

__asm__(".symver __libc_start_main,__libc_start_main@GLIBC_2.2.5");

/* also disable the local glob with make_cv_sys_gnu_glob=yes */
__asm__(".symver glob,glob@GLIBC_2.2.5");
