use warpui::App;

use super::*;
use crate::terminal::model::session::{SessionId, SessionInfo};

fn line_editor_status(shell_type: ShellType, app: &mut App) -> ModelHandle<LineEditorStatus> {
    let session_id = SessionId::from(42);
    let mut sessions = Sessions::new_for_test();
    sessions.register_session_for_test(
        SessionInfo::new_for_test()
            .with_id(session_id)
            .with_shell_type(shell_type),
    );
    let sessions = app.add_model(|_| sessions);
    let (_events_tx, events_rx) = async_channel::unbounded();
    let dispatcher = app.add_model(|ctx| {
        let mut dispatcher = ModelEventDispatcher::new(events_rx, sessions.clone(), ctx);
        dispatcher.set_active_session_id(session_id);
        dispatcher
    });
    app.add_model(|ctx| LineEditorStatus::new(dispatcher, sessions, ctx))
}

#[test]
fn zsh_unset_bracketed_paste_cancels_pending_line_editor_activation() {
    App::test((), |mut app| async move {
        let status = line_editor_status(ShellType::Zsh, &mut app);
        status.update(&mut app, |status, ctx| {
            status.mark_line_editor_active_after_delay(LINE_EDITOR_ACTIVATION_DELAY, ctx);
            assert!(status.mark_line_editor_active_abort_handle.is_some());
            status.handle_model_event(
                &ModelEvent::Handler(AnsiHandlerEvent::UnsetBracketedPaste),
                ctx,
            );
            assert!(status.mark_line_editor_active_abort_handle.is_none());
            assert!(!status.is_line_editor_active());
        });
    });
}

#[test]
fn non_zsh_unset_bracketed_paste_does_not_change_line_editor_status() {
    App::test((), |mut app| async move {
        let status = line_editor_status(ShellType::Fish, &mut app);
        status.update(&mut app, |status, ctx| {
            status.is_line_editor_active = true;
            status.handle_model_event(
                &ModelEvent::Handler(AnsiHandlerEvent::UnsetBracketedPaste),
                ctx,
            );
            assert!(status.is_line_editor_active());
        });
    });
}
