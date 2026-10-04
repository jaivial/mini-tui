//! Reports: `report.json`, `junit.xml` (CI), `report.md` (a pull-request comment). All text
//! goes through the secret scrubber.

use super::coordinator::TestResult;
use super::secrets::scrub;
use serde_json::json;
use std::path::Path;

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn write_all(dir: &Path, base_url: &str, env: Option<&str>, results: &[TestResult]) -> Result<(), String> {
    let passed = results.iter().filter(|r| r.status == "pass").count();
    let total_cost: f64 = results.iter().map(|r| r.cost).sum();
    let tests: Vec<_> = results
        .iter()
        .map(|r| {
            json!({
                "name": r.name, "file": r.file, "status": r.status, "reason": r.reason, "profile": r.profile,
                "seconds": r.seconds, "cost": r.cost, "screenshots": r.screenshots,
                "steps": r.steps.iter().map(|s| json!({"step": s.label, "status": s.status, "source": s.source, "detail": s.detail, "seconds": s.seconds, "cost": s.cost, "subagent": s.subagent})).collect::<Vec<_>>(),
            })
        })
        .collect();
    let report = json!({"base_url": base_url, "environment": env, "passed": passed, "total": results.len(), "cost": total_cost, "tests": tests});
    std::fs::write(dir.join("report.json"), scrub(&serde_json::to_string_pretty(&report).unwrap())).map_err(|e| e.to_string())?;

    let mut j = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites tests=\"{}\" failures=\"{}\">\n<testsuite name=\"e2e\" tests=\"{}\" failures=\"{}\">\n", results.len(), results.len() - passed, results.len(), results.len() - passed);
    for r in results {
        j.push_str(&format!("  <testcase name=\"{}\" classname=\"{}\" time=\"{}\">", xml(&r.name), xml(&r.file), r.seconds));
        if r.status != "pass" {
            let steps: Vec<String> = r.steps.iter().map(|s| format!("{} [{}] {}: {}", s.status, s.source, s.label, s.detail)).collect();
            j.push_str(&format!("\n    <failure message=\"{}\">{}</failure>\n  ", xml(&r.reason), xml(&steps.join("\n"))));
        }
        j.push_str("</testcase>\n");
    }
    j.push_str("</testsuite>\n</testsuites>\n");
    std::fs::write(dir.join("junit.xml"), scrub(&j)).map_err(|e| e.to_string())?;

    let mut md = format!("## e2e: {passed}/{} passed\n\nBase URL: `{base_url}`{} · cost ${total_cost:.4}\n\n| | Test | Profile | Time | Notes |\n|---|---|---|---|---|\n", results.len(), env.map(|e| format!(" (environment `{e}`)")).unwrap_or_default());
    for r in results {
        let icon = match r.status.as_str() {
            "pass" => "✅",
            "fail" => "❌",
            _ => "⚠️",
        };
        let cached = r.steps.iter().filter(|s| s.source == "cache").count();
        let note = if r.status == "pass" { if cached > 0 { format!("{cached} step(s) replayed from cache") } else { String::new() } } else { r.reason.replace('|', "\\|").replace('\n', " ") };
        md.push_str(&format!("| {icon} | {} | {} | {:.1} s | {} |\n", r.name.replace('|', "\\|"), r.profile, r.seconds, note));
    }
    for r in results.iter().filter(|r| r.status != "pass") {
        md.push_str(&format!("\n<details><summary>{}</summary>\n\n", r.name));
        for s in &r.steps {
            md.push_str(&format!("- {} `{}` ({}) — {}\n", if s.status == "pass" { "✓" } else { "✗" }, s.label.replace('`', "'"), s.source, s.detail.replace('\n', " ")));
        }
        md.push_str("\n</details>\n");
    }
    std::fs::write(dir.join("report.md"), scrub(&md)).map_err(|e| e.to_string())
}
