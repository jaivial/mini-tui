# What a Linux filesystem is

## Short answer

A **Linux filesystem** is the scheme the Linux kernel uses to organize, store, retrieve,
name, and protect data on storage devices — plus the actual on-disk layout that implements
that scheme. It turns raw blocks on a disk (or SSD, network share, RAM, …) into the tree
of files and directories you navigate with paths like `/home/you/notes.txt`.

"Filesystem" is used for three related things:

1. **The design/protocol** — how directories, file names, permissions, timestamps and
   contents are represented (ext4, XFS, Btrfs, FAT32, NTFS, …).
2. **The kernel code** that implements that design (the ext4 driver in the Linux kernel).
3. **A specific formatted volume** — e.g. "the filesystem on `/dev/sda1`".

## How it fits together

```
your program  ── open("/tmp/a.txt") ──►  syscall (VFS)  ──►  filesystem driver (ext4, …)
                                                        │
                                          block layer / device driver
                                                        │
                                            disk blocks (4 KiB sectors, …)
```

- **VFS (Virtual File System).** Linux's key indirection layer: every `open`, `read`,
  `write`, `stat` syscall goes through VFS, which dispatches to the driver for whichever
  filesystem is mounted at that path. That is why one process can read ext4 on `/`,
  a FAT32 USB stick at `/media/usb`, and `/proc` (a *pseudo*-filesystem) with the same
  `read()` call.
- **Mounting.** Filesystems don't have drive letters; each one is attached to a directory
  (*mount point*) in the single global tree rooted at `/`. `mount -t ext4 /dev/sda1 /data`
  grafts that volume's root onto `/data`. At boot, `/etc/fstab` declares what gets mounted.
- **Block devices.** Real filesystems live on block devices (`/dev/sda1`, `nvme0n1p2`,
  LVM volumes, loop devices). Device files under `/dev` are themselves files that let
  programs talk to the kernel's device drivers.

## What a filesystem keeps track of

- **Inodes.** Each file has an inode holding its metadata — size, owner, permissions,
  timestamps, and pointers to its data blocks — but *not* its name. Directories are just
  files mapping names → inode numbers. Hard links are two names for one inode; the last
  link deleting the inode frees the data.
- **Permissions.** The classic `rwxrwxrwx` bits plus a user/group/other model, plus
  setuid/setgid, sticky bit, and extended attributes (ACLs, capabilities, SELinux labels).
- **Directory hierarchy.** Everything hangs off `/`. The Filesystem Hierarchy Standard
  (FHS) standardizes the top level: `/etc` config, `/var` changing data (logs, caches),
  `/home` user data, `/usr` installed programs, `/tmp` scratch space, `/proc` and `/sys`
  kernel-provided views of processes and hardware.
- **Free space & allocation.** Bitmaps/journal structures tracking which blocks are free
  and how files claim them (extents, indirect blocks, copy-on-write trees in Btrfs/bcachefs).
- **Journaling (and COW).** ext4/XFS journal intended changes so a crash replays to a
  consistent state; Btrfs/ZFS instead copy-on-write, never overwriting good data.

## Common Linux filesystems

| Filesystem | Where you typically see it |
| --- | --- |
| **ext4** | Default root filesystem on most distros; mature, journaling |
| **XFS** | Large files/volumes, parallel I/O (RHEL default) |
| **Btrfs/ZFS** | Snapshots, compression, checksumming, RAID-in-software |
| **FAT32/exFAT** | USB sticks, SD cards shared with Windows/macOS |
| **NTFS** | Windows partitions (via ntfs-3g/ntfs3) |
| **tmpfs** | RAM-backed `/tmp`, `/run`, swap-backed scratch |
| **procfs / sysfs** | Virtual: `/proc` (processes), `/sys` (devices/drivers) |
| **overlayfs** | Layered images — Docker/containers build on this |
| **NFS / CIFS(SMB)** | Network shares exported/mounted over the network |

## Everyday tools

- `lsblk`, `fdisk -l` / `parted` — list devices and partitions
- `mkfs.ext4 /dev/sda1` — format (create) a filesystem
- `mount` / `umount`, `/etc/fstab` — attach/detach, persist across boots
- `df -h` — free space per mount; `du -sh *` — usage per directory
- `stat file`, `ls -l`, `namei -l path` — inspect inodes, permissions, links
- `fsck` — check/repair a filesystem offline

## One-sentence summary

A Linux filesystem is the combination of an on-disk format (ext4, XFS, Btrfs, …) and the
kernel's VFS layer that together present all your storage — and even virtual kernel
interfaces — as one seamless, permission-checked tree of files and directories rooted at `/`.
