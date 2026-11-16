import { spawn as spawnProcess } from "node:child_process";

export async function createVideoEncoder(response, options = {}) {
  const executable = options.executable ?? process.env.CODEG_EGO_VIDEO_ENCODER;
  if (!executable) throw new Error("视频编码器未配置，请使用原画面通道。");
  const spawn = options.spawn ?? spawnProcess;
  const args = ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", "30", "-use_wallclock_as_timestamps", "1",
    "-vcodec", "mjpeg", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0", "-an",
    "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-tune", "zerolatency",
    "-crf", "20", "-profile:v", "baseline", "-level:v", "4.2", "-pix_fmt", "yuv420p",
    // 编码必须跑得过真实时间；大屏保留宽高比限至 1080p，原 JPEG 仍保留完整清晰度。
    "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,setsar=1",
    "-g", "30", "-bf", "0", "-fps_mode", "vfr", "-movflags", "+empty_moov+default_base_moof+frag_every_frame",
    "-flush_packets", "1", "-f", "mp4", "pipe:1"];
  const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("视频编码器无法启动，请使用原画面通道。")));
    });
  } catch (error) { child.kill(); throw error; }
  let closed = false;
  let latest = null;
  let blocked = false;
  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.stdin.on("drain", () => { blocked = false; });
  // Windows 后台计时器和编码背压会漏拍；PTS 必须取实际墙钟，不能把 25 次写入当成 1 秒的 30 帧。
  const timer = setInterval(() => {
    if (!closed && !blocked && latest) blocked = !child.stdin.write(latest);
  }, options.intervalMs ?? 1000 / 30);
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer); latest = null;
    child.stdout.unpipe(response); child.kill();
  };
  child.once("close", () => { close(); response.end(); });
  child.on("error", () => { close(); response.destroy?.(); });
  response.once("close", close);
  return {
    start() { if (!closed) child.stdout.pipe(response); },
    write(frame) { if (!closed) latest = frame; },
    close,
  };
}
