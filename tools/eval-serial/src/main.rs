// eval-serial — Serial port CLI tool for Eval
// Usage: eval-serial <action> [args...]
// All output is JSON to stdout. Errors go to stderr.

use serialport::{available_ports, SerialPort};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::time::Duration;

#[derive(serde::Serialize)]
struct JsonResult {
    success: bool,
    data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn ok(data: serde_json::Value) -> JsonResult {
    JsonResult { success: true, data, error: None }
}
fn err(msg: &str) -> JsonResult {
    JsonResult { success: false, data: serde_json::Value::Null, error: Some(msg.to_string()) }
}

fn print_json(r: &JsonResult) {
    println!("{}", serde_json::to_string(r).unwrap());
    if !r.success {
        std::process::exit(1);
    }
}

fn list_ports() {
    match available_ports() {
        Ok(ports) => {
            let list: Vec<serde_json::Value> = ports.iter().map(|p| {
                serde_json::json!({
                    "port": p.port_name.clone(),
                    "description": format!("{:?}", p.port_type),
                })
            }).collect();
            print_json(&ok(serde_json::json!({ "ports": list })));
        }
        Err(e) => print_json(&err(&format!("Failed to list ports: {}", e))),
    }
}

fn open_port(port: &str, baud_rate: u32) -> Result<Box<dyn SerialPort>, String> {
    serialport::new(port, baud_rate)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", port, e))
}

fn cmd_open(port: &str, baud_rate: u32) {
    match open_port(port, baud_rate) {
        Ok(_) => print_json(&ok(serde_json::json!({
            "port": port,
            "baudRate": baud_rate,
            "status": "opened",
        }))),
        Err(e) => print_json(&err(&e)),
    }
}

fn cmd_send(port: &str, baud_rate: u32, data: &str) {
    match open_port(port, baud_rate) {
        Ok(mut p) => {
            // 处理转义序列 \n \r \t
            let unescaped = data.replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t");
            match p.write_all(unescaped.as_bytes()) {
                Ok(_) => {
                    p.flush().ok();
                    print_json(&ok(serde_json::json!({ "sent": data })));
                }
                Err(e) => print_json(&err(&format!("Write error: {}", e))),
            }
        }
        Err(e) => print_json(&err(&e)),
    }
}

fn cmd_receive(port: &str, baud_rate: u32, timeout_ms: u64) {
    match open_port(port, baud_rate) {
        Ok(mut p) => {
            let mut buf = vec![0u8; 4096];
            let start = std::time::Instant::now();
            let mut collected = Vec::new();
            loop {
                match p.read(&mut buf) {
                    Ok(n) if n > 0 => {
                        collected.extend_from_slice(&buf[..n]);
                        // 有数据就返回，不等到超时
                        if collected.len() >= 1024 { break; }
                    }
                    Err(e) if e.kind() == ErrorKind::TimedOut => {}
                    Err(e) => print_json(&err(&format!("Read error: {}", e))),
                    _ => {}
                }
                if start.elapsed().as_millis() > timeout_ms as u128 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            let text = String::from_utf8_lossy(&collected).to_string();
            print_json(&ok(serde_json::json!({
                "data": text,
                "length": collected.len(),
            })));
        }
        Err(e) => print_json(&err(&e)),
    }
}

fn cmd_monitor(port: &str, baud_rate: u32, duration_secs: u64) {
    match open_port(port, baud_rate) {
        Ok(p) => {
            let mut reader = BufReader::new(p);
            let start = std::time::Instant::now();
            let mut lines = Vec::new();
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        if start.elapsed().as_secs() >= duration_secs { break; }
                    }
                    Ok(_) => {
                        lines.push(line.trim_end().to_string());
                        // 实时输出每一行
                        println!("{}", serde_json::to_string(&ok(serde_json::json!({
                            "line": line.trim_end(),
                        }))).unwrap());
                        if lines.len() >= 1000 { break; }
                    }
                    Err(e) if e.kind() == ErrorKind::TimedOut => {
                        if start.elapsed().as_secs() >= duration_secs { break; }
                    }
                    Err(e) => {
                        print_json(&err(&format!("Read error: {}", e)));
                    }
                }
                if start.elapsed().as_secs() >= duration_secs {
                    break;
                }
            }
            // 结束时输出汇总
            eprintln!("SERIAL_MONITOR_END");
        }
        Err(e) => {
            print_json(&err(&e));
        }
    }
}

fn print_help() {
    eprintln!("eval-serial v0.1.0 — Serial port CLI for Eval");
    eprintln!();
    eprintln!("Actions:");
    eprintln!("  list                              List available serial ports");
    eprintln!("  open <port> <baud>                Open a serial port (test connectivity)");
    eprintln!("  send <port> <baud> <data>         Send data to serial port");
    eprintln!("  receive <port> <baud> [timeout]   Receive data from serial port (default 2s)");
    eprintln!("  monitor <port> <baud> [duration]  Monitor serial port output (default 30s)");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        print_help();
        std::process::exit(2);
    }

    match args[1].as_str() {
        "list" => list_ports(),
        "open" => {
            if args.len() < 4 { print_help(); std::process::exit(2); }
            let baud: u32 = args[3].parse().unwrap_or(115200);
            cmd_open(&args[2], baud);
        }
        "send" => {
            if args.len() < 5 { print_help(); std::process::exit(2); }
            let baud: u32 = args[3].parse().unwrap_or(115200);
            cmd_send(&args[2], baud, &args[4]);
        }
        "receive" => {
            if args.len() < 4 { print_help(); std::process::exit(2); }
            let baud: u32 = args[3].parse().unwrap_or(115200);
            let timeout: u64 = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(2000);
            cmd_receive(&args[2], baud, timeout);
        }
        "monitor" => {
            if args.len() < 4 { print_help(); std::process::exit(2); }
            let baud: u32 = args[3].parse().unwrap_or(115200);
            let duration: u64 = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(30);
            cmd_monitor(&args[2], baud, duration);
        }
        _ => { print_help(); std::process::exit(2); },
    }
}
