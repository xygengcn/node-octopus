import colors from 'colors';

/**
 * 蓝色字体
 * @param text
 * @returns
 */
export function blueColor(text: string) {
    return colors.blue(text);
}

/**
 * 青色字体
 * @param text
 * @returns
 */
export function cyanColor(text: string) {
    return colors.cyan(text);
}

/**
 * 日志打印 黄色
 * @param title
 * @param args
 */
export function log(title: string, ...args: any[]) {
    console.log(colors.yellow(`[log]`), colors.yellow(title), ...args);
}

/**
 * 日志打印 青色
 * @param title
 * @param args
 */
export function debug(title: string, ...args: any[]) {
    console.log(cyanColor(`[debug]`), colors.yellow(title), ...args);
}

/**
 * 错误打印 红色
 * @param title
 * @param args
 */
export function error(title: string, ...args: any[]) {
    console.log(colors.red(`[error]`), colors.red(title), ...args);
}

/**
 * 成功打印 绿色
 * @param title
 * @param args
 */
export function success(title: string, ...args: any[]) {
    console.log(colors.green(`[success]`), colors.green(title), ...args);
}
