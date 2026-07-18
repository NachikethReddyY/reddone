#define _XOPEN_SOURCE 700

#include <errno.h>
#include <ftw.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static dev_t expected_device;

static int seal_entry(const char *path, const struct stat *details, int type, struct FTW *tree) {
  (void)tree;
  if (details == NULL) {
    fprintf(stderr, "cannot inspect generated entry: %s\n", path);
    return 1;
  }
  if (details->st_dev != expected_device) {
    fprintf(stderr, "generated mount point rejected: %s\n", path);
    return 1;
  }

  mode_t mode;
  if (type == FTW_DP || type == FTW_D) {
    mode = 0555;
  } else if (type == FTW_F) {
    if (details->st_nlink != 1) {
      fprintf(stderr, "generated hard link rejected: %s\n", path);
      return 1;
    }
    mode = 0444;
  } else {
    fprintf(stderr, "generated link or special file rejected: %s\n", path);
    return 1;
  }

  if (lchown(path, 0, 0) != 0 || chmod(path, mode) != 0) {
    fprintf(stderr, "cannot seal generated entry %s: errno %d\n", path, errno);
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  (void)argv;
  static const char *roots[] = {
      "/workspace/src/app/generated",
      "/workspace/src/components/generated",
      "/workspace/src/content",
      "/workspace/public/generated",
  };

  if (argc != 1 || geteuid() != 0) {
    fputs("generated source sealing requires the fixed privileged helper\n", stderr);
    return 77;
  }

  for (size_t index = 0; index < sizeof(roots) / sizeof(roots[0]); index++) {
    struct stat root_details;
    if (lstat(roots[index], &root_details) != 0 || !S_ISDIR(root_details.st_mode)) {
      fprintf(stderr, "generated root is missing or replaced: %s\n", roots[index]);
      return 1;
    }
    expected_device = root_details.st_dev;
    if (nftw(roots[index], seal_entry, 64, FTW_PHYS) != 0) {
      return 1;
    }
  }

  puts("generated source sealed read-only");
  return 0;
}
