//! Codeg 自己的 AI 助手：对语言模型发起生成请求，服务于标签建议与会话标题。
//!
//! 它与被聚合的智能体 CLI 无关——那些 CLI 自己调模型，Codeg 只是把提供方配置
//! 转发给它们。这里才是 Codeg 第一次真的"问模型一句话，并且拿到回答"。
//!
//! 复用 AI 提供方（`model_provider` 表）里已有的地址与密钥，因此本模块**不持有
//! 任何密钥**，也不让它们进日志或错误文本。
//!
//! 分层刻意压平，目的只有一个：让"会花钱"的判断都能被纯函数测试覆盖。
//! - [`context`] 从会话里取要喂给模型的正文；
//! - [`output`] 把模型的自由回答收成结构化结果；
//! - [`gate`] 决定这一轮要不要重新生成标题；
//! - [`settings`] 设置与可用性；
//! - [`wire`] 两种协议的请求体与响应取值；
//! - [`client`] 唯一会发网络请求的地方，也是唯一新增的跨层 seam。

pub mod client;
pub mod context;
pub mod gate;
pub mod output;
pub mod settings;
pub mod suggest;
pub mod title_gen;
pub mod wire;

/// 测试用的假客户端。只在测试或 `test-utils` 下编译。
#[cfg(any(test, feature = "test-utils"))]
pub mod fake;
