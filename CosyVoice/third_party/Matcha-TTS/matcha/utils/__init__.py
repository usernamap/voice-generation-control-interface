import importlib

_EXPORTS = {
    "instantiate_callbacks": ("matcha.utils.instantiators", "instantiate_callbacks"),
    "instantiate_loggers": ("matcha.utils.instantiators", "instantiate_loggers"),
    "log_hyperparameters": ("matcha.utils.logging_utils", "log_hyperparameters"),
    "get_pylogger": ("matcha.utils.pylogger", "get_pylogger"),
    "enforce_tags": ("matcha.utils.rich_utils", "enforce_tags"),
    "print_config_tree": ("matcha.utils.rich_utils", "print_config_tree"),
    "extras": ("matcha.utils.utils", "extras"),
    "get_metric_value": ("matcha.utils.utils", "get_metric_value"),
    "task_wrapper": ("matcha.utils.utils", "task_wrapper"),
}

__all__ = list(_EXPORTS.keys())


def __getattr__(name):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, attr_name = _EXPORTS[name]
    module = importlib.import_module(module_name)
    value = getattr(module, attr_name)
    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals().keys()) | set(__all__))
