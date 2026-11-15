export class BrowserControlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class PageGroupControl {
  constructor(saved = {}) {
    this.owner = saved.owner ?? null;
    this.epoch = (saved.epoch ?? 0) + 1;
    this.recoveryRequired = saved.recoveryRequired ?? false;
    this.nativeResumeAuthorized = false;
    this.stopped = false;
    this.pending = Promise.resolve();
    this.waiters = new Set();
  }

  snapshot() {
    return {
      owner: this.owner,
      epoch: this.epoch,
      recoveryRequired: this.recoveryRequired,
    };
  }

  checkEpoch(epoch) {
    if (epoch !== this.epoch) {
      throw new BrowserControlError("stale_control", "控制权已变化，请同步最新状态后重试。");
    }
  }

  checkOwner(clientId) {
    if (this.owner !== null && this.owner !== clientId) {
      throw new BrowserControlError("read_only", "当前为只读，请先点击“接管到此设备”。");
    }
  }

  checkRecovery() {
    if (this.recoveryRequired) {
      throw new BrowserControlError("recovery_required", "执行环境已恢复，请先确认恢复页面和任务。");
    }
  }

  enqueue(operation) {
    const guarded = () => {
      this.checkRunning();
      return operation();
    };
    const result = this.pending.then(guarded, guarded);
    this.pending = result.catch(() => {});
    return result;
  }

  async runAgent(operation) {
    const retry = Symbol();
    for (;;) {
      this.checkRunning();
      // 暂停时不占用组内队列，否则人工输入和交还也会被一起堵住。
      if (this.owner !== null || this.recoveryRequired) {
        await new Promise((resolve) => this.waiters.add(resolve));
        continue;
      }
      const epoch = this.epoch;
      const result = await this.enqueue(() => {
        if (this.owner !== null || this.recoveryRequired || epoch !== this.epoch) return retry;
        return operation();
      });
      if (result !== retry) return result;
    }
  }

  wakeAgents() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  checkRunning() {
    if (this.stopped) {
      throw new BrowserControlError("ego_disconnected", "页面通道已结束，未确认的操作不会自动重放。");
    }
  }

  stop() {
    this.stopped = true;
    this.recoveryRequired = true;
    this.wakeAgents();
  }

  runHuman(clientId, epoch, operation, { transfer = false } = {}) {
    if (typeof clientId !== "string" || clientId.length < 8 || clientId.length > 128) {
      throw new BrowserControlError("invalid_client", "设备标识无效。");
    }
    if (!transfer) this.checkRecovery();
    this.checkEpoch(epoch);
    if (!transfer) this.checkOwner(clientId);
    if (this.owner !== clientId) {
      // 先记录暂停，再等待在途动作结束，阻止后来排队的 Agent 动作继续。
      this.owner = clientId;
      this.epoch += 1;
      this.nativeResumeAuthorized = false;
    }
    const acceptedEpoch = this.epoch;
    return this.enqueue(async () => {
      this.checkEpoch(acceptedEpoch);
      this.checkOwner(clientId);
      return operation();
    });
  }

  returnToAgent(clientId, epoch) {
    this.checkRecovery();
    this.checkEpoch(epoch);
    if (this.owner !== clientId) {
      throw new BrowserControlError("read_only", "只有当前接管设备可以交还 Agent。");
    }
    return this.enqueue(() => {
      this.checkEpoch(epoch);
      this.checkOwner(clientId);
      // 这里只提交授权；原生恢复留到下一个 Agent 动作内，避免异步恢复越过新设备接管。
      this.owner = null;
      this.epoch += 1;
      // 恢复授权必须先于唤醒等待者，避免第一个排队动作误判为未经交还。
      this.nativeResumeAuthorized = true;
      this.wakeAgents();
    });
  }

  confirmRecovery() {
    this.recoveryRequired = false;
    this.epoch += 1;
    this.wakeAgents();
  }
}
