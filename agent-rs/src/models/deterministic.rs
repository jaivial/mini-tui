//! The scripted test models (`models/test_models.py`): replies come from `outputs` in order;
//! a `/sleep N` action sleeps and moves to the next output, `/warning x` logs and moves on.

use super::shapes::{expand_multimodal, response_observations, text_observations, toolcall_observations};
use super::{DeltaSink, Model, ModelError, Reply};
use crate::util::Obj;
use serde_json::{json, Value};

const DEFAULT_OBSERVATION: &str = "{% if output.exception_info %}<exception>{{output.exception_info}}</exception>\n{% endif %}<returncode>{{output.returncode}}</returncode>\n<output>\n{{output.output}}</output>";

#[derive(PartialEq)]
enum Kind {
    Text,
    Toolcall,
    Response,
}

pub struct DeterministicModel {
    kind: Kind,
    config: Obj,
    outputs: Vec<Value>,
    index: usize,
}

impl DeterministicModel {
    pub fn new(class: &str, config: &Obj) -> Result<Self, String> {
        let (kind, default_name, ty) = match class {
            "deterministic" => (Kind::Text, "deterministic", "DeterministicModel"),
            "deterministic_toolcall" => (Kind::Toolcall, "deterministic_toolcall", "DeterministicToolcallModel"),
            _ => (Kind::Response, "deterministic_response_api_toolcall", "DeterministicResponseAPIToolcallModel"),
        };
        let outputs = config.get("outputs").and_then(Value::as_array).cloned().ok_or("the deterministic model needs `outputs`")?;
        // pydantic's model_dump: declared fields only, in declaration order.
        let mut c = Obj::new();
        c.insert("outputs".into(), Value::Array(outputs.clone()));
        c.insert("model_name".into(), config.get("model_name").cloned().unwrap_or(json!(default_name)));
        let cost = config.get("cost_per_call").and_then(Value::as_f64).unwrap_or(1.0);
        c.insert("cost_per_call".into(), json!(cost));
        c.insert("observation_template".into(), config.get("observation_template").cloned().unwrap_or(json!(DEFAULT_OBSERVATION)));
        c.insert("multimodal_regex".into(), config.get("multimodal_regex").cloned().unwrap_or(json!("")));
        c.insert("__type".into(), json!(ty));
        Ok(DeterministicModel { kind, config: c, outputs, index: 0 })
    }

    fn dump(&self) -> Obj {
        let mut c = self.config.clone();
        c.shift_remove("__type");
        c
    }
}

impl Model for DeterministicModel {
    fn query(&mut self, _messages: &[Value], _sink: Option<DeltaSink>) -> Result<Reply, ModelError> {
        loop {
            let Some(output) = self.outputs.get(self.index).cloned() else {
                return Err(ModelError { message: "list index out of range".into(), status: None, abort: true, kind: "IndexError".into() });
            };
            self.index += 1;
            let actions = output.pointer("/extra/actions").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut retry = false;
            for a in &actions {
                let cmd = a.get("command").and_then(Value::as_str).unwrap_or("");
                if let Some(secs) = cmd.strip_prefix("/sleep ") {
                    if !crate::agent::interruptible_sleep(std::time::Duration::from_secs_f64(secs.trim().parse().unwrap_or(0.0))) {
                        return Err(ModelError { message: "interrupted".into(), status: None, abort: true, kind: "KeyboardInterrupt".into() });
                    }
                    retry = true;
                    break;
                }
                if let Some(msg) = cmd.strip_prefix("/warning") {
                    eprintln!("WARNING:root:{msg}");
                    retry = true;
                    break;
                }
            }
            if retry {
                continue;
            }
            return Ok(Reply::Message(output));
        }
    }

    fn format_message(&self, role: &str, content: &str, extra: Option<Obj>) -> Value {
        if self.kind == Kind::Response {
            let mut m = json!({"type": "message", "role": role, "content": [{"type": "input_text", "text": content}]});
            if let Some(e) = extra.filter(|e| !e.is_empty()) {
                m["extra"] = Value::Object(e);
            }
            return m;
        }
        let mut m = json!({"role": role, "content": content});
        if let Some(e) = extra {
            m["extra"] = Value::Object(e);
        }
        let re = self.config.get("multimodal_regex").and_then(Value::as_str).unwrap_or("");
        if re.is_empty() {
            m
        } else {
            expand_multimodal(&m, re)
        }
    }

    fn format_observation_messages(&self, message: &Value, outputs: &[Value], template_vars: &Value) -> Result<Vec<Value>, String> {
        let template = self.config["observation_template"].as_str().unwrap_or("");
        let re = self.config["multimodal_regex"].as_str().unwrap_or("");
        match self.kind {
            Kind::Text => text_observations(outputs, template, template_vars, re),
            Kind::Toolcall => toolcall_observations(message, outputs, template, template_vars, re),
            Kind::Response => response_observations(message, outputs, template, template_vars),
        }
    }

    fn template_vars(&self) -> Obj {
        self.dump()
    }

    fn serialize(&self) -> Value {
        let ty = format!("minisweagent.models.test_models.{}", self.config["__type"].as_str().unwrap_or(""));
        json!({"info": {"config": {"model": self.dump(), "model_type": ty}}})
    }

    fn model_name(&self) -> String {
        self.config["model_name"].as_str().unwrap_or("").to_string()
    }

    fn context_window(&self) -> i64 {
        0
    }
}
