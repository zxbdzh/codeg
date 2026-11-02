use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn http_rate_limits_preserve_the_server_wait_without_exposing_credentials() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 2048];
        socket.read(&mut request).await.unwrap();
        let body = "try later: test-api-key";
        let response = format!("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 300\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    let client = HttpAiClient::new().unwrap();
    let request = CompletionRequest {
        protocol: crate::acp::provider_models::ModelsProtocol::Openai,
        url: format!("http://{address}/chat/completions"),
        headers: Vec::new(),
        body: serde_json::json!({ "messages": [] }),
        api_key: "test-api-key".into(),
    };
    let error = tokio::time::timeout(Duration::from_secs(5), client.complete(request))
        .await
        .unwrap()
        .unwrap_err();
    server.await.unwrap();
    assert_eq!(error.retry_after_seconds(), Some(300));
    assert!(!error.to_string().contains("test-api-key"));
}
