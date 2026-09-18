import { useEffect } from "react";
import { Form, Input, Modal, Select } from "antd";
import { useMyPromptStore, type MyPromptItem } from "@/stores/use-my-prompt-store";

type MyPromptModalProps = {
    open: boolean;
    initialData?: MyPromptItem | null;
    onClose: () => void;
    onSuccess?: (item: MyPromptItem) => void;
};

export function MyPromptModal({ open, initialData, onClose, onSuccess }: MyPromptModalProps) {
    const [form] = Form.useForm<{ title: string; prompt: string; tags: string[] }>();
    const addPrompt = useMyPromptStore((state) => state.addPrompt);
    const updatePrompt = useMyPromptStore((state) => state.updatePrompt);

    useEffect(() => {
        if (!open) return;
        if (initialData) {
            form.setFieldsValue({
                title: initialData.title,
                prompt: initialData.prompt,
                tags: initialData.tags || [],
            });
        } else {
            form.resetFields();
        }
    }, [form, initialData, open]);

    const handleOk = async () => {
        try {
            const values = await form.validateFields();
            if (initialData) {
                updatePrompt(initialData.id, values);
                onSuccess?.({
                    ...initialData,
                    ...values,
                    updatedAt: Date.now(),
                });
            } else {
                const id = addPrompt(values);
                onSuccess?.({
                    id,
                    ...values,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                });
            }
            onClose();
        } catch {
            // 表单校验失败
        }
    };

    return (
        <Modal
            title={initialData ? "编辑提示词" : "新建自定义提示词"}
            open={open}
            onOk={handleOk}
            onCancel={onClose}
            okText="保存"
            cancelText="取消"
            destroyOnClose
            centered
        >
            <Form form={form} layout="vertical" className="mt-4">
                <Form.Item
                    name="title"
                    label="简短标题"
                    rules={[{ required: true, message: "请输入简短标题" }]}
                >
                    <Input placeholder="例如：电影质感、动漫少女、二次元雨夜" maxLength={30} showCount />
                </Form.Item>

                <Form.Item
                    name="prompt"
                    label="提示词内容"
                    rules={[{ required: true, message: "请输入提示词正文" }]}
                >
                    <Input.TextArea
                        rows={4}
                        placeholder="输入生图提示词（支持中英文，如：masterpiece, 8k, cinematic lighting...）"
                        showCount
                    />
                </Form.Item>

                <Form.Item name="tags" label="标签（按回车添加）">
                    <Select
                        mode="tags"
                        placeholder="例如：写实、人像、风景、质感"
                        tokenSeparators={[",", " "]}
                        options={[
                            { value: "写实", label: "写实" },
                            { value: "摄影", label: "摄影" },
                            { value: "二次元", label: "二次元" },
                            { value: "动漫", label: "动漫" },
                            { value: "风景", label: "风景" },
                            { value: "人像", label: "人像" },
                            { value: "光影", label: "光影" },
                            { value: "国风", label: "国风" },
                        ]}
                    />
                </Form.Item>
            </Form>
        </Modal>
    );
}
