#ifndef ROME_COMPUTER_USE_IDENTITY_H
#define ROME_COMPUTER_USE_IDENTITY_H
#include <stdint.h>
#include <stddef.h>
int rome_process_identity(int32_t pid, uint64_t *seconds, uint64_t *micros, char *path, size_t capacity);
#endif
