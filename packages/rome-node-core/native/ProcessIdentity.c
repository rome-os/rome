#include "ProcessIdentity.h"
#include <libproc.h>
#include <sys/proc_info.h>
#include <string.h>
#include <unistd.h>

int rome_process_identity(int32_t pid, uint64_t *seconds, uint64_t *micros, char *path, size_t capacity) {
    if (pid <= 0 || !seconds || !micros || !path || capacity < PROC_PIDPATHINFO_MAXSIZE) return -1;
    *seconds = 0;
    *micros = 0;
    memset(path, 0, capacity);
    struct proc_bsdinfo before = {0}, after = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before)) return -2;
    if (before.pbi_pid != (uint32_t)pid || before.pbi_uid != getuid()) return -3;
    if (!before.pbi_start_tvsec || before.pbi_start_tvusec >= 1000000) return -4;
    int size = proc_pidpath(pid, path, (uint32_t)capacity);
    if (size <= 0 || (size_t)size >= capacity || path[0] != '/') return -5;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != (int)sizeof(after)) return -6;
    if (after.pbi_pid != before.pbi_pid || after.pbi_uid != before.pbi_uid ||
        after.pbi_start_tvsec != before.pbi_start_tvsec || after.pbi_start_tvusec != before.pbi_start_tvusec) return -7;
    *seconds = before.pbi_start_tvsec;
    *micros = before.pbi_start_tvusec;
    return 1;
}
