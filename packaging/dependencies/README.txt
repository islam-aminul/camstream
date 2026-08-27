Put the agent's runtime dependencies in this directory before installing.

The installer extracts whatever it finds here into the installation directory
and points the agent at those exact binaries. Nothing is taken from PATH, and
nothing is installed system-wide, so the agent keeps running the versions you
put here no matter what else changes on the box afterwards.

WHAT TO PUT HERE
----------------
Two archives. Download them on any machine and copy them in — the installer
needs no internet access.

  1. A Java runtime, version 21 or newer
     Windows / Linux / macOS:  https://adoptium.net/temurin/releases/
     Choose "JRE", your platform, and the .zip or .tar.gz package.

     On Windows choose the x64 build even on an ARM machine. The AWS IoT
     native library is not published for Windows on ARM; an x64 JRE runs
     under emulation and works normally.

  2. An FFmpeg build that includes ffmpeg and ffprobe
     Windows:  https://www.gyan.dev/ffmpeg/builds/  (.7z or .zip)
               https://github.com/BtbN/FFmpeg-Builds/releases  (.zip)
     Linux:    https://johnvansickle.com/ffmpeg/  (.tar.xz)
     macOS:    https://evermeet.cx/ffmpeg/  (.7z or .zip, ffmpeg and ffprobe
               are separate downloads — put both here)

ACCEPTED ARCHIVE FORMATS
------------------------
  .zip  .7z  .tar.gz  .tgz  .tar.xz  .tar.bz2  .tar

Leave them exactly as downloaded — do not unpack them yourself. The installer
looks inside for the real binaries wherever the archive happens to put them,
which differs between builds.

A LICENSING NOTE
----------------
CamStream stream-copies by default and needs no GPL codec, so an LGPL FFmpeg
build is enough and is what you should ship. Most convenient Windows builds are
GPL, which is fine for evaluation but must not be redistributed as part of a
commercial product. Transcoding needs an encoder: prefer your hardware's
(vaapi, nvenc, qsv, amf) or libopenh264, all of which keep the build LGPL.
See LICENSING.md.
