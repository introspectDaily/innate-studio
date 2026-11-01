// RunningHub 的实时预览：接住工作流里 ModelPreviewOverrideKJ（节点 337）推出来的中间帧。
//
// 这个节点每采样一步就用 taeh3 解码一帧，编成 mp4 / 动图 webp / jpeg，
// 以 `kj_preview_override` 事件定向发给「提交这个 prompt 的 client_id」。
// 它不写盘、不进 history、不进 outputs，所以 REST 查询永远拿不到——只能自己当那个客户端连 WS。
//
// RunningHub 的提交响应里有 netWssUrl + clientId。官方把 netWssUrl 标注为「not recommended
// currently, unstable」，所以这里只当它是锦上添花的通道：
//   - 连不上、收不到帧、地址是 null，都不算错误，主流程照常走轮询；
//   - 只保留最近一帧（内存里，不落盘），前端低频拉取；
//   - 任务到终态就断开。
//
// 事件格式（KJNodes 发的）：{ type: 'kj_preview_override', data: { image: '<base64>', mime, w, h, step, total, step_ms } }

const sessions = new Map();

// 最多留多少帧的历史（只留最近一帧 + 一小段元信息）。
const MAX_META = 32;

function keyOf(taskId) {
  return String(taskId);
}

// 收 WS 消息：文本的按 JSON 解，二进制的是 ComfyUI 的「4B 事件类型 + 4B 长度 + JSON + 图像」。
function handleMessage(session, data) {
  const taskId = session.taskId;
  if (typeof data === 'string') {
    let msg = null;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const type = String(msg?.type || '');
    if (type === 'kj_preview_override') {
      const payload = msg?.data || {};
      const image = payload.image || payload.image_base64 || '';
      if (typeof image === 'string' && image) {
        session.frame = { data: image, mime: String(payload.mime || 'image/jpeg'), w: Number(payload.w) || 0, h: Number(payload.h) || 0 };
        session.step = Number(payload.step) || session.step;
        session.total = Number(payload.total) || session.total;
        session.stepMs = Number(payload.step_ms) || 0;
        session.updatedAt = Date.now();
        session.frames += 1;
      }
      return;
    }
    if (type === 'progress') {
      session.progress = { value: Number(msg?.data?.value) || 0, max: Number(msg?.data?.max) || 0 };
      session.node = String(msg?.data?.node || session.node || '');
      return;
    }
    if (type === 'executing') {
      session.node = String(msg?.data?.node || session.node || '');
      return;
    }
    if (type === 'execution_error' || type === 'execution_interrupted') {
      session.error = String(msg?.data?.exception_message || msg?.data?.exception_type || '工作流执行失败');
      return;
    }
    return;
  }
  // 二进制帧：普通节点的预览图（这次用不上，但记下来方便判断通道是不是通的）。
  session.binaryFrames = (session.binaryFrames || 0) + 1;
}

// 开始监听一个任务的预览通道。
export function startPreview(taskId, netWssUrl, clientId) {
  const id = keyOf(taskId);
  if (!netWssUrl) return null;
  stopPreview(id);
  const base = String(netWssUrl);
  const url = base + (base.includes('?') ? '&' : '?') + 'clientId=' + encodeURIComponent(String(clientId || ''));
  const session = { taskId: id, url, frame: null, step: 0, total: 0, stepMs: 0, progress: null, node: '', frames: 0, updatedAt: 0, error: '', state: 'connecting', log: [] };
  sessions.set(id, session);
  try {
    const ws = new WebSocket(url);
    session.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      session.state = 'open';
    });
    ws.addEventListener('error', () => {
      session.state = 'error';
    });
    ws.addEventListener('close', () => {
      session.state = 'closed';
    });
    ws.addEventListener('message', async (event) => {
      try {
        if (typeof event.data === 'string') {
          handleMessage(session, event.data);
          return;
        }
        const buf = Buffer.from(await event.data.arrayBuffer());
        if (buf.length > 8) {
          const len = buf.readUInt32BE(4);
          const meta = len > 0 && 8 + len <= buf.length ? JSON.parse(buf.subarray(8, 8 + len).toString('utf8')) : {};
          session.log.push(meta);
          if (session.log.length > MAX_META) session.log.shift();
        }
      } catch {
        /* 预览是附加功能，坏掉就当没有 */
      }
    });
  } catch {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function stopPreview(taskId) {
  const id = keyOf(taskId);
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.ws?.close();
  } catch {
    /* ignore */
  }
  sessions.delete(id);
}

// 给前端的预览状态。frame.data 是 base64（不落盘，接口现给现用）。
export function previewState(taskId) {
  const session = sessions.get(keyOf(taskId));
  if (!session) return null;
  return {
    state: session.state,
    frame: session.frame,
    step: session.step,
    total: session.total,
    stepMs: session.stepMs,
    progress: session.progress,
    node: session.node,
    frames: session.frames,
    updatedAt: session.updatedAt,
    error: session.error,
  };
}

export const previewCount = () => sessions.size;
