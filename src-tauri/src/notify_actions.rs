//! Agent alerts with a Reply button. Linux (freedesktop notifications) shows "Reply" and opens
//! the chat with the composer focused when it's clicked; the page is told through the
//! `notification-action` event. Other desktops return false and the page falls back to the
//! notification plugin (clicking or focusing the app opens the chat there).
use tauri::{AppHandle, Runtime};

/// What the page should do after the user acted on an alert.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct Action {
    pub chat: String,
    /// "open" (clicked the alert) or "reply" (clicked Reply: focus the composer).
    pub action: &'static str,
}

/// Map a freedesktop action key to what the page does; None for a dismissed alert.
pub fn action_for(chat: &str, key: &str) -> Option<Action> {
    let action = match key {
        "default" => "open",
        "reply" => "reply",
        _ => return None,
    };
    Some(Action { chat: chat.to_string(), action })
}

#[tauri::command]
pub fn notify_actions<R: Runtime>(app: AppHandle<R>, chat: String, title: String, body: String, sound: bool) -> bool {
    #[cfg(target_os = "linux")]
    {
        use notify_rust::{Hint, Notification};
        use tauri::Emitter;
        let mut n = Notification::new();
        n.appname("Supercharge Studio").summary(&title).body(&body).icon("supercharge-studio").action("default", "Open").action("reply", "Reply");
        if sound {
            n.hint(Hint::SoundName("message-new-instant".into()));
        }
        let Ok(handle) = n.show() else { return false };
        std::thread::spawn(move || {
            handle.wait_for_action(|key| {
                if let Some(a) = action_for(&chat, key) {
                    crate::background::show_main(&app);
                    let _ = app.emit("notification-action", a);
                }
            });
        });
        true
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, chat, title, body, sound);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reply_and_click_open_the_chat_dismiss_does_nothing() {
        assert_eq!(action_for("c1", "reply"), Some(Action { chat: "c1".into(), action: "reply" }));
        assert_eq!(action_for("c1", "default").unwrap().action, "open");
        assert_eq!(action_for("c1", "__closed"), None);
    }
}
